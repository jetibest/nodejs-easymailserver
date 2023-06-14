#!/bin/sh

if ! [ -e /etc/letsencrypt ]
then
	echo "error: Unable to find the Let's Encrypt configuration directory (/etc/letsencrypt)." >&2
	exit 1
fi

if ! [ -e 001-easymailserver.sh ]
then
	echo "error: Execute this install script from within the directory it exists in." >&2
	echo "Like so:" >&2
	echo "" >&2
	echo "  ./install.sh" >&2
	echo "" >&2
	exit 1
fi

cp -v 001-easymailserver.sh /etc/letsencrypt/renewal-hooks/deploy/001-easymailserver.sh


