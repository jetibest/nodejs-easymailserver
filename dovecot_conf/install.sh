#!/bin/sh

if ! [ -e /etc/dovecot ]
then
	echo "error: Unable to find the Dovecot configuration directory (/etc/dovecot)." >&2
	exit 1
fi

if ! [ -e 90-easymailserver.conf ]
then
	echo "error: Execute this install script from within the directory it exists in." >&2
	echo "Like so:" >&2
	echo "" >&2
	echo "  ./install.sh" >&2
	echo "" >&2
	exit 1
fi

cp -v 90-easymailserver.conf /etc/dovecot/conf.d/
cp -v dovecot-dict-auth-easymailserver.conf.ext /etc/dovecot/

# this assumes that /etc/dovecot/dovecot.conf contains a line with:
# !include conf.d/*.conf
