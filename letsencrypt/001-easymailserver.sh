#!/bin/bash

set -e # exit on any failure

wd="/srv/easymailserver/"
domain_name="$(head -n1 "$wd"config/me || hostname -d)"
pem_filename="$domain_name".pem
pem_file="$wd"config/tls/"$pem_filename"

echo "Deploying renewed certificates from $domain_name to easymailserver..."

# note: currently the config/tls directory may only contain PEM files, and nothing else (no subdirectories, or the reading of certificates will fail in Haraka/tls_socket.js::exports.get_certs_dir)

# copy certificate of the domain to the config/tls directory
[ -e "$wd"config/tls ] || mkdir -p "$wd"config/tls
[ -e "$wd"config/tls-old ] || mkdir -p "$wd"config/tls-old
cat /etc/letsencrypt/live/"$domain_name"/privkey.pem /etc/letsencrypt/live/"$domain_name"/fullchain.pem >"$pem_file".new
chown -R vmail:vmail "$wd"config/tls
chown -R vmail:vmail "$wd"config/tls-old

# check if certificate for this domain was actually renewed:
if cmp --silent -- "$pem_file".new "$pem_file"
then
	echo "No change, nothing to do."
	
	# clean up:
	rm -f "$pem_file".new
	
	exit 0
fi

# make a backup of the current pem-file
cp -f "$pem_file" "$wd"config/tls-old/"$pem_filename"

# replace current pem-file with new pem-file
mv -f "$pem_file".new "$pem_file"

# restarting easymailserver will reload the certificates for TLS
systemctl restart easymailserver

# reload dovecot IMAP server
if systemctl is-active dovecot
then
	# note: dovecot should be configured to directly use /etc/letsencrypt/live/<domain>/privkey.pem since it has root permissions when it is starting up
	# but alternatively, it may refer to the combined /srv/easymailserver/config/tls/<domain>.pem file
	systemctl reload dovecot
fi

echo "Renewal success."
