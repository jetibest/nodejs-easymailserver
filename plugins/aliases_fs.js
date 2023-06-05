//aliases_fs

// This plugin must run before any other queue-plugin.
// It changes the rcpt_to to recipients based on the rules for that recipient.
// So for each recipient, it modifies the recipients list.
// Based on their own conditional rules.
// For instance, any e-mail to 'john' containing "invoice" in the subject, might be forwarded to 'john+invoice'
// The maildir plugin will make sure that 'john+invoice' is stored for the maildir: john/.invoice

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

// register() initializes the plugin, is typically used to first load the configuration
exports.register = function()
{
	const plugin = this;
	
	plugin.load_config();
};

exports.load_config = function()
{
	const plugin = this;

	const cfg = plugin.cfg = plugin.config.get('aliases_fs.ini', {booleans: ['-*.keep_original']}, () => plugin.load_config());
	
	// set defaults:
	
	// for a whole domain, we would use the catch-all, and then do 'vmail/<domain>/@/aliases'
	// or even just do a symlink: vmail/<domain> --> vmail/<other-domain>
	if(cfg.main?.path == null) cfg.main.path = 'vmail/<domain>/<user>/aliases';
	
	// if keep_original is not true, aliases_fs will overwrite the user itself, and thus an empty file will mean the mail will not be delivered at all (=dropped/discarded)
	
	plugin.loginfo('plugin config (config/aliases_fs.ini) => ' + util.inspect(plugin.cfg));
};

function parse_regex(str)
{
	var regex_match = str.match(/\/(.*?)\/([a-z]*)?$/i);
	if(regex_match !== null)
	{
		return new RegExp(regex_match[1], regex_match[2]);
	}
	// losely match with whitespaces on both ends, and case-insensitive
	return new RegExp('^\\s*' + str.split('*').map(str => str.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, '\\$1')).join('.*') + '\\s*$', 'gi');
}

exports.hook_queue = async function(next, connection)
{
	const txn = connection?.transaction;
	
	// hook_queue is only called for inbound mail, so connection.relaying is never true here
	
	if(txn == null) return next();
	
	const plugin = this;
	const cfg = plugin.cfg;
	
	// note: this plugin ignores txn.notes.get('queue.wants') because it is a preprocessing plugin for the real queue hooks
	
	const recipients = txn.rcpt_to.slice();
	const header = txn.header;
	
	const new_recipients = [];

	for(const recipient of recipients)
	{
		const user = recipient.user;
		const host = recipient.host;
		const original_host = recipient.original_host;
		
		// try section [user@host], then try [host], then fallback to [main] which is the default section
		const aliases_cfg = cfg[user + '@' + host] || cfg[user + '@' + original_host] || cfg[host] || cfg[original_host] || cfg.main;
		
		const aliases_cfg_keep_original = aliases_cfg.keep_original;
		const aliases_cfg_path = formatVarpath(aliases_cfg.path, recipient);
		
		plugin.logdebug('hook_queue: Processing aliases for recipient (' + recipient + ') in ' + aliases_cfg_path + ' (keep_original = ' + aliases_cfg_keep_original + ')', connection);

		// the path can be a directory or a file, handle both:
		var rulefiles = [];
		try
		{
			rulefiles = await fs.promises.readdir(aliases_cfg_path);
		}
		catch(err)
		{
			if(err.code === 'ENOTDIR')
			{
				rulefiles = [aliases_cfg_path];
			}
			else if(err.code !== 'ENOENT')
			{
				plugin.logerror('Unexpected error: Possible configuration error, failed to apply aliases (' + err.code + ') for directory (' + aliases_cfg_path + ').', connection);
				plugin.logerror(util.inspect(err), connection);
				
				if(err.code !== 'EPERM' && err.code !== 'EACCES')
				{
					// error must be thrown, events_fs cannot function properly due to filesystem i/o errors
					throw err;
				}
				else
				{
					// error is caught and printed, because this is a non-fatal error, crashing the mailserver would not be useful here
				}
			}
			else
			{
				// else: ENOENT is safe to ignore, it could mean no directory for this event exists
			}
		}
		
		const aliases = [];
		var has_rulefile = false;
		
		for(const file of rulefiles)
		{
			plugin.loginfo('hook_queue: Applying aliases for recipient (' + recipient + ') from file: ' + file, connection);
			
			try
			{
				const data = await fs.promises.readFile(file, {encoding: 'utf8'});
				const lines = data.split('\n');
				
				for(var i=0;i<lines.length;++i)
				{
					var line = lines[i].trim(); // lines and matching is always case-insensitive, and forced to be lowercase
					
					// skip empty lines
					if(line.length === 0) continue;
					
					// skip comments (#, ;)
					if(line.startsWith('#') || line.startsWith(';')) continue;
					
					// we want to forward if regex matches, or we want to forward if regex does NOT match
					var matchline = line;
					
					var negated = false;
					if(matchline.startsWith('!'))
					{
						negated = true;
						matchline = matchline.substring(1);
					}
					
					if(/^[a-z0-9-]+:/gi.test(matchline))
					{
						var headerkey = matchline.split(':')[0];
						var headerval = matchline.substring(matchline.indexOf(':') + 1).trim();
						var matched = false;
						
						var regex = parse_regex(headerval);
						
						// if multiple headers, this only selects the first header
						var header_values = header.get(headerkey).split('\n');
						
						// when multiple header values exist for one header definition, then those are split up, and only one needs to match
						for(var j=0;j<header_values.length;++j)
						{
							plugin.logdebug('Header-rule for header: (' + headerkey + '[' + j + ']: ' + header_values[j] + ') using match: ' + util.inspect(regex), connection);
							
							if(regex.test(header_values[j]))
							{
								matched = true;
							}
						}
						
						if(negated === matched)
						{
							plugin.logdebug('Header-rule' + (negated ? ' (negated)' : '') + ' failed to match inbound message: ' + line, connection);

							break;  // when not negated break if not matched, when negated break if matched
						}
					}
					else
					{
						// this is an email address, even if @ does not exist, then it must be the username of that same domain
						if(line.indexOf('@') === -1) line += '@' + host;
						
						// the user is not filled in, so use the same user as the target address
						if(line.startsWith('@')) line = user + line;
						
						try
						{
							const alias = new Address(line.toLowerCase());
							
							plugin.logdebug('Adding alias: ' + alias, connection);
							
							// add user to recipients (but in lowercase)
							if(new_recipients.findIndex(rcpt => rcpt.original === alias.original) === -1)
							{
								new_recipients.push(alias);
							}

							// only when an alias is succesfully added, then it should replace the original recipient
							has_rulefile = true; // an aliases file was succesfully read
						}
						catch(err)
						{
							// invalid chars in Address, parse exception, when using special chars that are not allowed
							plugin.logerror('Unexpected error (bad configuration): Invalid alias address (' + line + ') for file (' + file + ') for recipient: ' + recipient, connection);
							plugin.logerror(util.inspect(err), connection);
						}
					}
				}
			}
			catch(err)
			{
				if(err.code !== 'ENOENT')
				{
					plugin.logerror('Unexpected error: Possible configuration error, failed to apply aliases (' + err.code + ') for file (' + file + ').', connection);
					plugin.logerror(util.inspect(err), connection);

					if(err.code !== 'EPERM' && err.code !== 'EACCES')
					{
						// error must be thrown, events_fs cannot function properly due to filesystem i/o errors
						throw err;
					}
				}
				// else: safe to ignore ENOENT, an aliases file is not mandatory to exist
			}
		}
		
		// add original recipient if no rulefile was applied, or if original must be preserved as per configuration
		if(!has_rulefile || aliases_cfg_keep_original)
		{
			plugin.logdebug('Adding original recipient to the list (' + recipient + ')', connection);
			
			if(new_recipients.findIndex(rcpt => rcpt.original === recipient.original) === -1)
			{
				new_recipients.push(recipient);
			}
		}
	}
	
	// apply new recipients
	txn.rcpt_to = new_recipients;
	
	// if the file is empty, but exists, then the action is to drop/discard any incoming e-mail for this person
	if(txn.rcpt_to.length === 0)
	{
		plugin.loginfo('hook_queue: OK: Consuming because no recipients left after aliases_fs, for original recipients: ' + recipients.join(', '), connection);
		return next(OK);
	}
	
	plugin.loginfo('hook_queue: CONT: New recipients list: ' + txn.rcpt_to.join(', ') + ' from original recipients: ' + recipients.join(', '), connection);
	return next();
};
