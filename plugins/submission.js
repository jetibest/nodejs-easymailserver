//submission

// Listen at port :465 with the given TLS certificate, and forward any traffic to :25

const net = require('net');
const tls = require('tls');
const fs = require('fs');
const util = require('util');

exports.register = function()
{
	const plugin = this;

	plugin.load_config();
};

exports.load_config = function()
{
	const plugin = this;

	const cfg = plugin.cfg = plugin.config.get('submission.ini', () => plugin.load_config());
	
	// set defaults:
	
	if(cfg.main?.delay_ms == null) cfg.main.delay_ms = 200;
	
	plugin.loginfo('plugin config (config/submission.ini) => ' + util.inspect(plugin.cfg));
};

exports.forward_tls_socket = function(socket)
{
	const plugin = this;
	var smtp_socket = null;
	
	socket.on('error', err =>
	{
		if(smtp_socket === null) return;
		
		plugin.logdebug('Submission TLS-socket (' + socket.remoteAddress + ':' + socket.remotePort + ') error: ' + err.code);
		
		if(!smtp_socket.destroyed) smtp_socket.destroy(err);
	});
	socket.on('close', () =>
	{
		clearTimeout(timer);
		
		if(smtp_socket === null) return;
		
		plugin.loginfo('Submission TLS-socket (' + socket.remoteAddress + ':' + socket.remotePort + ') closed.');
	});
	
	// timeout before connecting to :25, this could simply be a health-check by a monitoring program,
	// which will immediately reset the connection after TLS handshake
	// but would lead to an abundance of ECONNRESET logs
	var timer = setTimeout(() =>
	{
		smtp_socket = net.connect(25);
		smtp_socket.on('connect', () =>
		{
			plugin.loginfo('Submission TLS-socket (' + socket.remoteAddress + ':' + socket.remotePort + ') accepted on :465, connected to :25 via ' + smtp_socket.localAddress + ':' + smtp_socket.localPort);
		});
		smtp_socket.on('error', err =>
		{
			plugin.logdebug('Submission SMTP-socket error: ' + err.code);
			
			if(!socket.destroyed) socket.destroy(err);
		});
		
		// pipe sockets to each other
		socket.pipe(smtp_socket);
		smtp_socket.pipe(socket);
	}, plugin.cfg.main.delay_ms);
};

exports.hook_init_master = function(next)
{
	const plugin = this;

	plugin.logdebug('Starting TLS Server for Submission port :465).');
	
	const server = plugin.server = tls.createServer({
		key: fs.readFileSync('config/tls_key.pem'),
		cert: fs.readFileSync('config/tls_cert.pem'),
		requestCert: false,
		rejectUnauthorized: false
	});
	server.on('secureConnection', socket =>
	{
		exports.forward_tls_socket(socket);
	});
	server.on('error', err =>
	{
		plugin.logerror('Submission unable to listen on :465 for TLS connections: ' + util.inspect(err));
		return next(DENY);
	});
	server.listen(465, () =>
	{
		plugin.loginfo('Submission listening on :465 for TLS connections, will forward to :25...');
		return next();
	});
};

exports.shutdown = function()
{
	const plugin = this;

	plugin.server.close();
};
