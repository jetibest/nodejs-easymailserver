const fs = require('fs');
const path = require('path');
const SMTPServer = require('smtp-server').SMTPServer;
const SimpleMailParser = require('mailparser').simpleParser;

var storagePath;
var counter;

const ok = p => new Promise((resolve, reject) => p.then(res => resolve(res || true)).catch(reject));
const readFile = p => fs.promises.readFile(p);
const storeFile = (filename, data) => ok(fs.promises.writeFile(path.resolve(storagePath, filename), data));

var smtpconnect = function(session, callback)
{
	console.log('Connection accepted from: ' + session.remoteAddress);
	callback(false);
};
var smtplogin = function(auth, session, callback)
{
	console.log('User authenticated: ' + auth.username + '/' + auth.password + ' using ' + auth.method);
	callback(false, {user: auth.username || 'anonymous'});
};
var smtpreceive = function(address, session, callback)
{
	console.log('Receiving e-mail from: ' + address.address);
	callback(false);
};
var smtpsend = function(domains)
{
	var re = new RegExp('^.*@((.*[.])*)((' + (domains.map(str => '[' + str.split('').join('][').replace(/\[\*\]/gi, '.*') + ']').join(')|(')) + '))$', 'i');
	return function(address, session, callback)
	{
		// console.log('Sending e-mail to: ' + address.address);
		// Check if domain-name matches our inbox domain
		if(!domains.length || re.test(address.address))
		{
			session.mailboxAddress = address.address;
			callback(false);
		}
		else
		{
			callback(new Error('ERROR: Relaying e-mail to another server is not supported.'));
		}
	};
};
var smtpdata = async function(stream, session, callback)
{
	// store in directories with date, so that we can easily access through filesystem as well
	// session.envelope.mailFrom === {...} || false
	// session.envelope.rcptTo === [...] || []
	console.log('SMTP Data received');
	var mailobj = await SimpleMailParser(stream, {}).catch(callback);
	if(!mailobj)
	{
		stream.end();
		return;
	}
	
	// use session.envelope to place e-mail in the right directory
	// session.envelope.rcptTo is a list of addresses
	// store e-mail as a JSON file
	console.log(session);
	var mailbox = (session.mailboxAddress +'').replace(/@[^@]*$/gi, '').replace(/[^a-z0-9+-]+/gi, '').split('+');
	var maildomain = (session.mailboxAddress +'').replace(/^.*@/gi, '').replace(/[^a-z0-9.-]+/gi, '').split('.').reverse().join('.');
	var d = new Date();
	var dstr = (d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()).split('-').map(v => ('0'+v).replace(/^0([0-9][0-9]+)/gi, ($0,$1) => $1)).join('-');
	var mailboxdir = path.resolve(storagePath, maildomain + '/' + mailbox[0] + '/' + dstr);
	var fileID = maildomain + '/' + mailbox[0] + '/' + dstr + '/mail.' + Date.now() + '-' + (counter++);
	console.log(mailboxdir + ' -> ' + fileID);
	
	// ensure date directory exists
	if(!await ok(fs.promises.mkdir(mailboxdir, {recursive: true})).catch(callback))
	{
		console.log('error: mkdir failed for: ' + mailboxdir);
		stream.end();
		return;
	}
	
	mailobj.tags = mailbox.slice(1);
	
	if(mailobj.attachments.length)
	{
		for(var i=0;i<mailobj.attachments.length;++i)
		{
			// write binary data separately from JSON, to keep JSON small to parse
			if(!await storeFile(fileID + '.attachments.' + i + '.bin', mailobj.attachments[i].content, 'binary').catch(callback))
			{
				stream.end();
				return;
			}
			delete mailobj.attachments[i].content;
			mailobj.attachments[i].storageFilename = fileID + '.attachments.' + i + '.bin';
			// "contentType":"image/jpeg","partId":"1.2","release":null,"contentDisposition":"inline","filename":"aprilandme.jpg","contentId":"<ii_k1hdjld80>","cid":"ii_k1hdjld80","related":true,"headers":{},"checksum":"bb103835bc38a2e3a131ae24864617fa","size":114154}}
		}
		if(!await storeFile(fileID + '.attachments.json', JSON.stringify(mailobj.attachments)).catch(callback))
		{
			stream.end();
			return;
		}
		delete mailobj.attachments;
	}
	
	if(!await storeFile(fileID + '.body.json', JSON.stringify({html: mailobj.html, text: mailobj.text, textAsHtml: mailobj.textAsHtml})).catch(callback))
	{
		stream.end();
		return;
	}
	delete mailobj.html;
	delete mailobj.text;
	delete mailobj.textAsHtml;
	
	if(!await storeFile(fileID + '.mail.json', JSON.stringify(mailobj)).catch(callback))
	{
		stream.end();
		return;
	}
	
	stream.end();
	callback(false);
};
var smtpclose = function()
{
	console.log('SMTP connection closed');
};
var smtperror = function(err)
{
	console.log('on.error:');
	console.log(err);
};

(async () =>
{
	var config = JSON.parse(await readFile('./config.json').catch(console.error) || '{}');
	config.smtp = config.smtp || {};

	storagePath = path.resolve(__dirname, config.storagePath || './storage/');
	counter = 0;
	
	var domains = config.domains || '';
	if(typeof domains === 'string')
	{
		domains = domains.split(',');
	}
	if(!Array.isArray(domains))
	{
		console.error('Syntax error (config.json): domains has to be an Array or String, or a comma-separated String.');
		return;
	}
	
	var port = parseInt(process.argv[2]) || config.port || 25;
	
	const server = new SMTPServer({
		key: await readFile(config.sslKeyPath || './ssl/private/key.pem').catch(console.error) || false,
		cert: await readFile(config.sslCertPath || './ssl/certs/cert.pem').catch(console.error) || false,
		secure: port !== 25,
		name: config.smtp.hostname || (config.domain ? 'mail.' + config.domain : '') || 'mail.example.com',
		banner: config.smtp.banner || 'Welcome to my mail-server. I can only read e-mail.',
		authMethods: ['PLAIN', 'LOGIN'],
		authOptional: true,
		allowinsecureAuth: true,
		logger: false,
		onAuth: smtplogin,
		onConnect: smtpconnect,
		onMailFrom: smtpreceive,
		onRcptTo: smtpsend(domains),
		onData: smtpdata,
		onClose: smtpclose
	});
	server.on('error', smtperror);
	console.log('Listening on 0.0.0.0:' + port);
	server.listen(port, config.host || '0.0.0.0'); // 465 = secure smtp, 25 = unsecure smtp
})();
