//mailauth
// see original code: https://www.npmjs.com/package/haraka-plugin-mailauth

'use strict';

const util = require('util');
const dns = require('dns');
const stream = require('stream');

// npm install mailauth
const { arc } = require('mailauth/lib/arc');
const { dmarc } = require('mailauth/lib/dmarc');
const { spf: checkSpf } = require('mailauth/lib/spf');
const { dkimVerify } = require('mailauth/lib/dkim/verify');
const { bimi } = require('mailauth/lib/bimi');

exports.register = function()
{
	const plugin = this;
	
	plugin.load_config();
	
	plugin.resolver = dns.promises.resolve; // async (name, rr) => await dns.promises.resolve(name, rr);
	
	plugin.register_hook('helo', 'mailauth_helo');
	plugin.register_hook('ehlo', 'mailauth_helo');
};

exports.load_config = function()
{
	const plugin = this;

	plugin.cfg = plugin.config.get('mailauth.ini', {}, () => this.load_config());
	
	// set defaults:
	
	if(plugin.cfg.main?.min_bit_length == null) plugin.cfg.main.min_bit_length = 1024;
	if(plugin.cfg.main?.dns_max_lookups == null) plugin.cfg.main.dns_max_lookups = 10;
	
	plugin.loginfo('plugin config (config/mailauth.ini) => ' + util.inspect(plugin.cfg));
};

exports.mailauth_helo = function(next, connection, helo)
{
	// don't apply mailauth verification when outbound
	if(connection.relaying) return next();
	
	connection.notes.mailauth_helo = helo;
	return next();
};

exports.mailauth_add_result = function(txn, key, domain, result)
{
	const plugin = this;
	
	const resultName = key + '[' + domain + ']';

	plugin.loginfo('mailauth_add_result: ' + resultName + ': ' + result);
	
	switch(result)
	{
		case 'pass':
			txn.results.add(plugin, { pass: resultName });
			break;
		case 'fail':
			txn.results.add(plugin, { fail: resultName });
			break;
		case 'neutral':
		case 'policy':
			txn.results.add(plugin, { skip: resultName });
			break;
		case 'permerror':
		case 'temperror':
			txn.results.add(plugin, { fail: resultName });
			break;
		case 'none':
		default:
			// ignore;
			break;
	}
};

exports.hook_mail = async function(next, connection, params)
{
	const plugin = this;
	const txn = connection?.transaction;
	
	// don't apply mailauth verification when outbound
	if(txn == null || connection.relaying) return next();
	
	const sender = params[0].address();
	txn.notes.mailauth = {
		sender
	};
	
	plugin.logdebug('hook_mail: Step 1. SPF for sender: ' + sender, connection);

	try
	{
		var spfResult = await checkSpf({
			resolver: plugin.resolver,
			ip: connection.remote_ip, // SMTP client IP
			helo: connection.notes.mailauth_helo, // EHLO/HELO hostname
			sender, // MAIL FROM address
			mta: connection.local.host, // MX hostname
			maxResolveCount: plugin.cfg.main.dns_max_lookups
		});

		plugin.logdebug('hook_mail: SPF Result: ' + util.inspect(spfResult), connection);
		
		txn.notes.mailauth.spf = spfResult;
		
		plugin.mailauth_add_result(txn, 'spf', spfResult?.domain, spfResult?.status?.result);
		
		if(spfResult.header)
		{
			txn.add_leading_header('Received-SPF', spfResult.header.substring(spfResult.header.indexOf(':') + 1).trim());
		}
		if(spfResult.info)
		{
			connection.auth_results(spfResult.info);
		}
	}
	catch(err)
	{
		plugin.catch_err('spf', err, connection);
	}

	return next();
};

exports.catch_err = function(name, err, connection)
{
	const plugin = this;
	
	connection.transaction.notes.mailauth[name] = {error: err};
	connection.transaction.results.add(plugin, {err: name});
	
	plugin.logerror(util.inspect(err), connection);
};

async function hookDataPostAsync(stream, plugin, connection)
{
	const txn = connection.transaction;
	
	plugin.logdebug('Step 2. DKIM', connection);
	
	let dkimResult;
	try
	{
		dkimResult = await dkimVerify(stream, {
			resolver: plugin.resolver,
			sender: txn.notes.mailauth.sender,
			seal: null,
			minBitLength: plugin.cfg.main.min_bit_length
		});

		txn.notes.mailauth.dkim = dkimResult;

		for(let result of dkimResult?.results || [])
		{
			plugin.mailauth_add_result(txn, 'dkim', result?.signingDomain, result?.status?.result);

			if(result.info)
			{
				connection.auth_results(result.info);
			}
		}
	}
	catch(err)
	{
		plugin.catch_err('dkim', err, connection);
	}
	
	plugin.logdebug('Step 3. ARC', connection);

	let arcResult;
	if(dkimResult?.arc)
	{
		try
		{
			arcResult = await arc(dkimResult.arc, {
				resolver: plugin.resolver,
				minBitLength: plugin.cfg.main.min_bit_length
			});
			
			txn.notes.mailauth.arc = arcResult;
			
			plugin.mailauth_add_result(txn, 'arc', arcResult?.signature?.signingDomain, arcResult?.status?.result);
			
			if(arcResult.info)
			{
				connection.auth_results(arcResult.info);
			}
		}
		catch(err)
		{
			plugin.catch_err('arc', err, connection);
		}
	}

	plugin.logdebug('Step 4. DMARC', connection);

	let dmarcResult;
	let spfResult = txn.notes.mailauth.spf;
	if(dkimResult?.headerFrom)
	{
		try
		{
			dmarcResult = await dmarc({
				resolver: plugin.resolver,
				headerFrom: dkimResult.headerFrom,
				spfDomains: [].concat((spfResult?.status?.result === 'pass' && spfResult?.domain) || []),
				dkimDomains: (dkimResult.results || []).filter(r => r.status.result === 'pass').map(r => r.signingDomain),
				arcResult
			});

			txn.notes.mailauth.dmarc = dmarcResult;

			plugin.mailauth_add_result(txn, 'dmarc', dmarcResult?.domain, dmarcResult?.status?.result);

			if(dmarcResult.info)
			{
				connection.auth_results(dmarcResult.info);
			}
		}
		catch(err)
		{
			plugin.catch_err('dmarc', err, connection);
		}
	}

	plugin.logdebug('Step 5. BIMI', connection);

	let bimiResult;
	if(dmarcResult)
	{
		try
		{
			bimiResult = await bimi({
				resolver: plugin.resolver,
				dmarc: dmarcResult,
				headers: dkimResult.headers
			});

			txn.notes.mailauth.bimi = bimiResult;

			plugin.mailauth_add_result(txn, 'bimi', bimiResult?.status?.header?.d, bimiResult?.status?.result);

			if(bimiResult.info)
			{
				connection.auth_results(bimiResult.info);
			}

			txn.remove_header('bimi-location');
			txn.remove_header('bimi-indicator');

		}
		catch(err)
		{
			plugin.catch_err('bimi', err, connection);
		}
	}
}

exports.hook_data_post = async function(next, connection)
{
	const plugin = this;
	const txn = connection?.transaction;

	// don't apply mailauth verification when outbound
	if(txn == null || connection.relaying) return next();
	
	const multistream = new stream.PassThrough();
	
	try
	{
		const verification = hookDataPostAsync(multistream, plugin, connection);
		
		await new Promise((resolve, reject) =>
		{
			multistream.on('error', err => reject);
			multistream.on('finish', resolve);
			
			txn.message_stream.on('error', err => multistream.destroy(err));
			txn.message_stream.pipe(multistream, {line_endings: '\r\n'});

			// start flowing... even if no handlers were attached
			multistream.resume();
		});
		
		await verification;
	}
	catch(err)
	{
		plugin.logerror(util.inspect(err), connection);
	}
	
	return next();
};

