//maildir

// This plugin stores inbound e-mail in a local maildir-format directory.

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const util = require('util');
const stream = require('node:stream');

function stripPlusAddressing(user)
{
	if(!user || typeof user !== 'string') return user;
	
	return user.replace(/[+].*$/g, '');
}
// turns alice+some+folder into .some.folder according to the Maildir++ directory layout
function getPlusAddressingPath(user)
{
	if(!user || typeof user !== 'string') return user;
	
	var index = user.indexOf('+');
	if(index === -1) return '';
	
	return user.substring(index) // start from first + inclusive
		.replace(/[/\0\\]+/g, '') // remove invalid characters
		.replace(/[+]/g, '.') // turn + into .
		.replace(/[.]+/g, '.'); // prevent multiple sequential dots
}
function formatVarpath(varpath, addr)
{
	if(!varpath || typeof varpath !== 'string') return varpath;
	
	if(addr?.host)
	{
		// note: uses punycode in filesystem path
		varpath = varpath.replace(/<(domain|domainname|host|hostname)>/gi, addr.host.replace(/[/\0\\]+/g, '').toLowerCase());
	}
	if(addr?.user)
	{
		// note: strips plus-addressing from user
		varpath = varpath.replace(/<(user|username)>/gi, stripPlusAddressing(addr.user).replace(/[/\0\\]+/g, '').toLowerCase());
	}

	return varpath;
}
function anyTypeOf(type, ...args)
{
	for(var i=0;i<args.length;++i)
	{
		var arg = args[i];

		if(typeof arg === type)
		{
			return arg;
		}
	}
	return args[args.length - 1];
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
	
	// import maildir.ini and overwrite config defaults
	plugin.cfg = plugin.config.get('maildir.ini', () => plugin.load_config());

	// set defaults:
	
	if(plugin.cfg.main?.id == null)
	{
		// set dynamic default value for id if not explicitly set
		try
		{
			plugin.cfg.main.id = fs.readFileSync('/etc/machine-id').toString('utf8').trim();
			plugin.loginfo('Using unique /etc/machine-id: ' + plugin.cfg.main.id);
		}
		catch(err)
		{
			plugin.cfg.main.id = crypto.randomBytes(12).toString('hex');

			if(err.code === 'ENOENT')
			{
				plugin.logwarn('/etc/machine-id not found, using random id: ' + plugin.cfg.main.id);
			}
			else
			{
				plugin.logerror('error (' + err.code + ') reading from /etc/machine-id, using random id: ' + plugin.cfg.main.id);
				plugin.logerror(util.inspect(err));
			}
		}
	}
	if(plugin.cfg.main?.maildir == null) plugin.cfg.main.maildir = 'vmail/<domain>/<user>';
	if(plugin.cfg.main?.defaultdir == null) plugin.cfg.main.defaultdir = 'vmail/<domain>/@';
	
	plugin.loginfo('plugin config (config/maildir.ini) => ' + util.inspect(plugin.cfg));
};

exports.hook_queue = async function(next, connection)
{
	const txn = connection?.transaction;

	if(!txn) return next();

	const plugin = this;
	const cfg = plugin.cfg;
	
	const q_wants = txn.notes.get('queue.wants');
	if(q_wants && q_wants !== 'maildir')
	{
		plugin.logdebug('skipping, unwanted (' + q_wants + ')', connection);
		return next();
	}
	
	const recipients = txn.rcpt_to;
	
	plugin.loginfo('hook_queue: Inbound e-mail for recipients: ' + recipients.join(', '), connection);
	
	// var messageID = txn.header.get('message-id');
	const unique_filename = cfg.main.id + '.' + process.pid + '.' + (plugin.autoincr = (plugin.autoincr || 0) + 1) + '.' + Date.now() + '.' + crypto.randomBytes(12).toString('hex');
	
	// recipient is already filtered, this is not equal to the To: header, any e-mail addresses with hosts that are not accepted by this server are not in these recipients
	// also, the sending MTA should already take care of this when specifying RCPT TO as part of the SMTP protocol
	const target_paths = [];
	for(const recipient of recipients)
	{
		const user = stripPlusAddressing(recipient.user);
		const user_subpath = getPlusAddressingPath(recipient.user);
		const host = recipient.host;
		const original_host = recipient.original_host;
		
		const recipient_maildir = anyTypeOf('string', cfg?.[user + '@' + host]?.maildir, cfg?.[user + '@' + original_host]?.maildir, cfg?.[host]?.maildir, cfg?.[original_host]?.maildir, cfg.main.maildir);
		
		if(!recipient_maildir)
		{
			plugin.logwarn('Possible misconfiguration detected for recipient ' + recipient + ', empty maildir set. Mail will not be stored for this recipient.', connection);
			continue;
		}
		
		const recipient_path = formatVarpath(recipient_maildir, recipient);
		const recipient_subpath = path.join(recipient_path, user_subpath);
		
		// check for duplicate maildirs in recipients:
		if(target_paths.findIndex(r => r.maildir === recipient_path) === -1)
		{
			target_paths.push({
				recipient: recipient,
				maildir: recipient_path,
				maildir_sub: recipient_subpath,
				maildir_tmp: path.join(recipient_subpath, 'tmp'),
				maildir_new: path.join(recipient_subpath, 'new'),
				maildir_tmp_file: path.join(recipient_subpath, 'tmp', unique_filename),
				maildir_new_file: path.join(recipient_subpath, 'new', unique_filename)
			});
		}
		// else: through aliasing or whatever other mechanism, this e-mail would be delivered multiple times in the same maildir
	}
	
	try
	{
		plugin.logdebug('Initializing tmp/ and new/ directories for: ', connection);
		plugin.logdebug(target_paths, connection);

		// cache map with resolved catch-all path for each domain
		var catch_all_root = {};
		
		// first pass, initialize directories
		for(var i=0;i<target_paths.length;++i)
		{
			var p = target_paths[i];
			
			// ensure parent directory of this file exists (note: if the parent directory does not exist, then apparently this user cannot receive e-mail)
			try
			{
				if(p.maildir_sub !== p.maildir)
				{
					// but only if a subpath exists (plus addressing)
					// then we will have to create that first
					// but if p.maildir does not exist, this must fail
					// that is, plus addressing inboxes are automatically created, but users are not
					await fs.promises.mkdir(p.maildir_sub);
				}
				await fs.promises.mkdir(p.maildir_tmp);
				await fs.promises.mkdir(p.maildir_new);
			}
			catch(err)
			{
				// directory already exists, but that's fine
				if(err.code === 'EEXIST')
				{
					// ignore
				}
				// the parent directory does not exist, that means this recipient does not yet have a mailbox, do NOT automatically create
				else if(err.code === 'ENOENT')
				{
					// deliver at catch-all instead, if has catch-all
					const recipient = p.recipient;
					const user = stripPlusAddressing(recipient.user);
					const user_subpath = getPlusAddressingPath(recipient.user);
					const host = recipient.host;
					const original_host = recipient.original_host;
					var catch_all_path = catch_all_root[host];
					var recipient_defaultdir = anyTypeOf('string', cfg[user + '@' + host]?.defaultdir, cfg[user + '@' + original_host]?.defaultdir, cfg[host]?.defaultdir, cfg[original_host]?.defaultdir, cfg.main.defaultdir);
					
					if(!catch_all_path && recipient_defaultdir)
					{
						try
						{
							catch_all_path = catch_all_root[host] = await fs.promises.realpath(formatVarpath(recipient_defaultdir, recipient));
						}
						catch(c_err)
						{
							if(c_err.code === 'ENOENT')
							{
								plugin.logdebug('Catch-all does not exist for configured path (' + recipient_defaultdir + ')', connection);
								// no catch-all setup, that's fine, it will lead to a DENY for this recipient
							}
							else
							{
								throw c_err; // some other error
							}
						}
					}

					if(catch_all_path && catch_all_path !== p.maildir)
					{
						var catch_all_subpath = path.join(catch_all_path, user_subpath);

						plugin.loginfo('hook_queue: Recipient (' + p.recipient + ') does not exist, catch all to: ' + catch_all_subpath, connection);

						p.maildir = catch_all_path;
						p.maildir_sub = catch_all_subpath;
						p.maildir_tmp = path.join(catch_all_subpath, 'tmp');
						p.maildir_new = path.join(catch_all_subpath, 'new');
						p.maildir_tmp_file = path.join(catch_all_subpath, 'tmp', unique_filename);
						p.maildir_new_file = path.join(catch_all_subpath, 'new', unique_filename);
						
						// try once more (to create tmp/new)
						--i;
						continue;
					}
					else
					{
						// if recipient does not exist, maybe we need to let another queue plugin deal with this?
						plugin.logwarn('Received e-mail for recipient (' + recipient + '), but does not have a mailbox at: ' + p.maildir, connection);
						return next(DENY, 'Recipient (' + recipient + ') does not exist.');
					}
				}
				else throw err; // some other error
			}
		}

		plugin.logdebug('Open write streams to all recipient target files', connection);
		
		// cannot use message_stream.pipe() with .pause() directly, see: https://github.com/haraka/message-stream/issues/4
		var multistream = new stream.PassThrough();
		
		// second pass, first open the write streams to all recipient target files, and then start writing to disk
		target_paths.forEach(p =>
		{
			var targetstream = fs.createWriteStream(p.maildir_tmp_file);
			
			targetstream.on('error', err => { throw err; });
			multistream.on('error', err => targetstream.destroy(err));
			multistream.pipe(targetstream);
		});
		
		plugin.logdebug('Actually receive message stream and write to piped streams', connection);
		
		if(target_paths.length > 0)
		{
			await new Promise((resolve, reject) =>
			{
				multistream.on('error', reject);
				multistream.on('finish', resolve);
				
				txn.message_stream.on('error', err => multistream.destroy(err));
				txn.message_stream.pipe(multistream);
				
				// start flowing... even if there are no handlers attached
				multistream.resume();
			});
		}
		
		plugin.logdebug('Move e-mail file from tmp/ to new/', connection);
		
		// third pass, move tmp/ to new/
		for(var i=0;i<target_paths.length;++i)
		{
			var p = target_paths[i];
			
			plugin.loginfo('hook_queue: Delivering e-mail to ' + p.recipient + ': ' + p.maildir_new_file, connection);

			// now atomically move file in tmp/ to new/
			await fs.promises.rename(p.maildir_tmp_file, p.maildir_new_file);
		}
		
		// reply OK to SMTP connected server
		return next(OK);
	}
	catch(err)
	{
		plugin.logerror('Error storing message in maildir (' + err.code + ') for target_paths: ' + util.inspect(target_paths), connection);
		plugin.logerror(util.inspect(err), connection);
		
		return next(DENYSOFT, 'Temporary error saving message to maildir storage.');
	}
};
