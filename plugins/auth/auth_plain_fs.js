//auth_plain_fs

// depends on:
//  - auth/auth_base

// responsible for setting connection.relaying to true, if authenticated
// any non-authenticated connection is considered inbound e-mail

const fs = require('fs');
const util = require('util');
const Address = require('address-rfc2821').Address;

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
	
	plugin.inherits('auth/auth_base');
	
	plugin.load_config();
};

exports.load_config = function()
{
	const plugin = this;

	plugin.cfg = plugin.config.get('auth_plain_fs.ini', () => plugin.load_config());
	
	// set defaults:
	
	if(plugin.cfg.main?.file == null) plugin.cfg.main.file = 'vmail/<domain>/<user>/password';
	if(plugin.cfg.main?.methods == null) plugin.cfg.main.methods = 'PLAIN,LOGIN,CRAM-MD5';

	plugin.loginfo('plugin config (config/auth_plain_fs.ini) => ' + util.inspect(plugin.cfg));
};

// here, we also do hook_mail
// because if outbound, then we want to ensure that we DENY if this auth user is allowed to send as the given sender
exports.hook_mail = async function(next, connection, params)
{
	const transaction = connection?.transaction;
	
	if(transaction == null) return;
	
	const plugin = this;
	const sender = params[0];
	const is_outbound = connection.relaying;
	
	// check if outbound
	if(!is_outbound) return next();
	
	// deny this outbound email to avoid an authorized user sending email with a From address that it doesn't own
	
	plugin.logdebug('hook_mail: Outbound mail checking if ' + sender + ' is allowed to send for logged in user', connection);
	
	// note:
	// if outbound, then connection.notes.auth_user MUST exist, and be created by an auth plugin (see auth/auth_base)
	// regardless of whether it was this auth plugin, or another auth plugin
	const auth_user = connection.notes.auth_user_address || new Address(connection.notes.auth_user);

	// check if auth user is the same as From address (sender), in that case, it should always pass
	if(auth_user.user === sender.user && auth_user.host === sender.host)
	{
		plugin.logdebug('auth user (' + auth_user.address() + ') is allowed to send for equal sender (' + sender.address() + ')', connection);
		transaction.results.add(plugin, {pass: 'mail_from(auth_user)'});
		return next();
	}

	// for the [+] suffix, then we allow this user to send outbound
	if(auth_user.host === sender.host)
	{
		if(auth_user.user.length > 0 && sender.user.substring(0, sender.user.indexOf('+')) === auth_user.user)
		{
			plugin.logdebug('auth user (' + auth_user.address() + ') is allowed to send for extended sender (' + sender.address() + ')', connection);
			transaction.results.add(plugin, {pass: 'mail_from(auth_user is extension of sender)'});
			return next();
		}
	}
	
	plugin.logdebug('auth user (' + auth_user.address() + ') is DENIED to send for sender (' + sender.address() + ')', connection);
	transaction.results.add(plugin, {fail: 'mail_from!auth_user', emit: true});
	return next(DENY);
};

exports.hook_capabilities = function(next, connection)
{
	const plugin = this;
	
	// don't allow AUTH unless private IP or encrypted
	if(!connection.remote.is_private && !connection.tls.enabled)
	{
		plugin.loginfo('Auth disabled for insecure public connection', connection);
		plugin.loginfo(connection.tls, connection);
		return next();
	}
	
	const config = plugin.cfg.main;
	
	var methods = null;
	if(config?.methods)
	{
		methods = config.methods.split(',').map(method => method.trim());
	}
	if(methods != null && methods.length > 0)
	{
		connection.capabilities.push('AUTH ' + methods.join(' '));
		connection.notes.allowed_auth_methods = methods;
	}
	
	plugin.loginfo('Auth methods: ' + util.inspect(methods), connection);
	
	return next();
};

// username must typically be <user>@<domain>
exports.get_plain_passwd = async function(username, connection, cb)
{
	const plugin = this;
	var username_addr = null;
	try
	{
		username_addr = new Address(username);
	}
	catch(err)
	{
		plugin.logdebug('Failed (' + err + ') to parse username (' + username + ') in get_plain_passwd.', connection);
		
		// returning undefined
		return cb();
	}

	const config = plugin.cfg[username] || plugin.cfg[username_addr.host] || plugin.cfg.main;
	
	const password_file = formatVarpath(config?.file, username_addr);
	
	plugin.logdebug('Retrieving plain password for username: ' + username + ' from file (' + password_file + ')', connection);
	
	if(password_file != null)
	{
		try
		{
			const password = (await fs.promises.readFile(password_file)).toString('utf8').trim();
			
			plugin.logdebug('password found');

			connection.notes.auth_user_address = username_addr;

			return cb(password);
		}
		catch(err)
		{
			if(err.code !== 'ENOENT')
			{
				plugin.logerror('Error (' + err.code + '): Failed to read password for user (' + username + ') from file (' + password_file + ').');
				plugin.logerror(util.inspect(err), connection);
			}
		}
	}
	else
	{
		plugin.loginfo('User (' + username + ') is disabled due to missing file (' + config?.file + ') from configuration (config/auth_plain_fs.ini).', connection);
	}
	
	plugin.logdebug('no password found, returning undefined');
	
	cb();
};
