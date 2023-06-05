//rcpt_to.host_fs

// This plugin checks if the host of a recipient for inbound or sender for outbound is configured on this server.
// The configuration is implicitly set by the existence of the vmail/<domain> directory
// (or another path configured in config/rcpt_to.host_fs.ini).

const fs = require('fs');
const util = require('util');

function stripPlusAddressing(user)
{
	if(!user || typeof user !== 'string') return user;
	
	return user.replace(/[+].*$/g, '');
}
function formatVarpath(varpath, addr)
{
	if(!varpath || typeof varpath !== 'string') return varpath;
	
	if(addr?.host)
	{
		varpath = varpath.replace(/<(domain|domainname|host|hostname)>/gi, addr.host.replace(/[/\0\\]+/g, '').toLowerCase());
	}
	if(addr?.user)
	{
		varpath = varpath.replace(/<(user|username)>/gi, stripPlusAddressing(addr.user).replace(/[/\0\\]+/g, '').toLowerCase());
	}

	return varpath;
}

exports.register = function()
{
	const plugin = this;

	plugin.load_config();
};

exports.load_config = function()
{
	const plugin = this;

	const cfg = plugin.cfg = plugin.config.get('rcpt_to.host_fs.ini', () => plugin.load_config());
	
	// set defaults:
	
	if(cfg.main?.path == null) cfg.main.path = 'vmail/<domain>';

	plugin.loginfo('plugin config (config/rcpt_to.host_fs.ini) => ' + util.inspect(plugin.cfg));
};

exports.has_host = async function(connection, addr)
{
	const plugin = this;
	const varpath = formatVarpath(plugin.cfg.main.path, addr);
	
	try
	{
		plugin.loginfo('has_host: Checking access for path: ' + varpath, connection);

		await fs.promises.access(varpath);
		
		// path exists
		return true;
	}
	catch(err)
	{
		if(err.code === 'ENOENT')
		{
			// path does not exist
			return false;
		}
		else if(err.code === 'EACCESS' || err.code === 'ELOOP' || err.code === 'ENAMETOOLONG' || err.code === 'EPERM')
		{
			// path may or may not exist, warn for possible configuration error, but don't crash the server
			plugin.logerror('Unexpected filesystem error (' + err.code + '). Unable to check host for: ' + addr + ' and path: ' + varpath, connection);
		}
		else
		{
			plugin.logerror('Fatal I/O error (' + err.code + '). Unable to check host for: ' + addr + ' and path: ' + varpath, connection);
			plugin.logerror(util.inspect(err));

			// serious filesystem i/o error, crash the program
			throw err;
		}
	}
	
	// assume path does not exist in case of bad filesystem-configuration
	return false;
};

exports.hook_mail = async function(next, connection, params)
{
	const txn = connection?.transaction;
	
	if(txn == null) return;
	
	const plugin = this;
	const sender = params[0];
	const is_outbound = connection.relaying;
	
	plugin.loginfo('hook_mail: Checking if ' + sender + ' host exists in filesystem (' + (is_outbound ? 'outbound' : 'inbound') + ')', connection);
	
	// check if sender is locally hosted by this server, if so, enable local_sender note
	if(await plugin.has_host(connection, sender))
	{
		plugin.loginfo('hook_mail: CONT: ' + sender.host + ' is locally hosted.', connection);
		txn.results.add(plugin, {pass: 'mail_from'});
		txn.notes.local_sender = true;
		return next();
	}
	else if(is_outbound)
	{
		// if outbound, but the host is not locally hosted, then deny sending, to prevent outgoing spam/phishing by authenticated users
		plugin.loginfo('hook_mail: DENY: Outbound mail from sender, but ' + sender.host + ' is not locally hosted.', connection);
		txn.results.add(plugin, {fail: 'mail_from!local'});
		return next(DENY);
	}
	
	// sender is not locally hosted
	plugin.loginfo('hook_mail: CONT: ' + sender.host + ' is not locally hosted.', connection);
	txn.results.add(plugin, {msg: 'mail_from!local'});
	return next();
};

exports.hook_rcpt = async function(next, connection, params)
{
	const txn = connection?.transaction;
	
	if(txn == null) return next();
	
	const plugin = this;
	const recipient = params[0];
	const is_outbound = connection.relaying;
	
	// Check for RCPT TO without an @ first - ignore those here
	if(!recipient.host)
	{
		txn.results.add(plugin, {fail: 'rcpt!domain'});
		return next();
	}
	
	plugin.loginfo('hook_rcpt: For recipient ' + recipient + ' (' + (is_outbound ? 'outbound' : 'inbound') + ')', connection);
	
	// if outbound, we must be authenticated
	
	// in this case, a client with relaying privileges is sending FROM a local
	// domain. For them, any RCPT address is accepted.
	if(is_outbound && txn.notes.local_sender)
	{
		plugin.loginfo('hook_rcpt: OK: Relaying local sender.', connection);
		txn.results.add(plugin, {pass: 'relaying local_sender'});
		return next(OK);
	}
	
	// for inbound mail, we check if host directory exists for this recipient's host
	if(!is_outbound && await plugin.has_host(connection, recipient))
	{
		plugin.loginfo('hook_rcpt: OK: Host exists in local filesystem.');

		// path exists because it can be accessed
		txn.results.add(plugin, {pass: 'rcpt_to'});
		return next(OK);
	}
	
	plugin.loginfo('hook_rcpt: CONT: host_fs cannot vouch for this recipient (notes.local_sender = ' + txn.notes.local_sender + ')', connection);
	
	// the MAIL FROM domain is not local and neither is the RCPT TO
	// Another RCPT plugin may yet vouch for this recipient.
	txn.results.add(plugin, {msg: 'rcpt!local'});
	return next();
};
