// Listen at port :587 with the given TLS certificate, and forward any traffic to :25

const net = require('net');
const tls = require('tls');
const fs = require('fs');

function forward_tls_socket(socket)
{
	console.log('Accepting socket on :587, will forward to :25');
	try
	{
	const smtp_socket = net.connect(25);
	
	socket.on('error', err =>
	{
		console.log('Inbound socket error: ' + err.code);
		smtp_socket.destroy();
	});
	smtp_socket.on('error', err =>
	{
		console.log('Outbound SMTP-socket error: ' + err.code);
		socket.destroy(err);
	});
	
	socket.pipe(smtp_socket);
	smtp_socket.pipe(socket);
	}
	catch(err)
	{
		console.log('ERROR: ', err);
	}
}

function init_server(next)
{
	console.log('Starting TLS Server for Submission port :587).');
	
	const server = tls.createServer({
		key: fs.readFileSync('config/tls_key.pem'),
		cert: fs.readFileSync('config/tls_cert.pem'),
		rejectUnauthorized: false
	});
	server.on('tlsClientError', err => {
		console.log('tlsClientErr:', err);
	});
	server.on('secureConnection', socket => {
		console.log('forwarding secureConnection socket: authorized=' + socket.authorized + ', alpnProtocol=' + socket.alpnProtocol + ', servername=' + socket.servername);
		forward_tls_socket(socket);
	});
/*	server.on('tlsClientError', function(err)
	{
		plugin.logdebug('Caught tlsClientError: ' + util.inspect(err));
	});
	server.on('clientError', function(err)
	{
		plugin.logdebug('Caught clientError: ' + util.inspect(err));
	});*/
	server.on('error', function(err)
	{
		console.error(err);
	});
	server.listen(587, () =>
	{
		console.log('Submission listening on :587 for TLS connections, will forward to :25...');
	});
}

init_server();

