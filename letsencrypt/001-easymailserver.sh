#!/bin/bash

set -e # exit on any failure

wd="/srv/easymailserver/"
domain_name="$(head -n1 "$wd"config/me || hostname -d)"
pem_file="$wd"config/tls/"$domain_name".pem

echo "Deploying renewed certificates from $domain_name to easymailserver..."

# copy certificate of the domain to the config/tls directory
[ -e "$wd"config/tls ] || mkdir -p "$wd"config/tls
cat /etc/letsencrypt/live/"$domain_name"/privkey.pem /etc/letsencrypt/live/"$domain_name"/fullchain.pem >"$pem_file".new
chown -R vmail:vmail "$wd"config/tls

# check if certificate for this domain was actually renewed:
if cmp --silent -- "$pem_file".new "$pem_file"
then
	echo "No change, nothing to do."
	
	# clean up:
	rm -f "$pem_file".new
	
	exit 0
fi

# make a backup of the current pem-file
cp -f "$pem_file" "$pem_file".old

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
