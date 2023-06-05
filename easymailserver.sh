#!/bin/bash

# EasyMailServer script
# 
# easymailserver.sh ensures (= it can be safely run multiple times):
# 
#  - NodeJS v16 or higher is used (using nvm)
#  - config/internalcmd_key exists
#  - config/me exists (shows warning if different than current hostname)
#  - config/tls_key.pem and config/tls_cert.pem exist
#  - config/dkim/ is setup for every domain in use
# 

set -e # automatically exit if any command fails

# detect if we need to install a later version of NodeJS (minimally required is v16)
need_stable_node=true

node_command="node"
if ! command -v "$node_command" >/dev/null 2>/dev/null
then
	node_command="nodejs"
fi
if command -v "$node_command" >/dev/null 2>/dev/null
then
	# check version
	node_version="$($node_command --version | sed -e 's/^v//g' -e 's/[.].*//g')"
	if [ "$node_version" -ge "16" ]
	then
		need_stable_node=false
	fi
fi

if $need_stable_node
then
	# try to source nvm if exists
	if [ -e nvm/nvm.sh ]
	then
		. nvm/nvm.sh
	fi
	if [ -e ~/.nvm/nvm.sh ]
	then
		. ~/.nvm/nvm.sh
	fi
	
	# if nvm is installed, use it to set NodeJS version to stable, or latest (this is useful for systems with an old native version of NodeJS)
	if command -v nvm >/dev/null 2>/dev/null
	then
		if ! nvm use stable
		then
			echo "Run ./install.sh"
		fi
	fi
fi

# ensure we are in the right local working directory (easymailserver/)
if ! [ -e easymailserver.sh ]
then
	echo "[easymailserver.sh] Error: easymailserver.sh must be run with its parent directory as the working directory." >&2
	exit 1
fi

# check if the vmail directory exists
if ! [ -e vmail/ ]
then
	echo "[easymailserver.sh] Error: The vmail directory does not exist. Note that vmail is by default a symlink to /var/vmail." >&2
	echo "[easymailserver.sh] Also ensure that the directory has the right permissions (chown -R vmail:vmail vmail/)." >&2
	exit 1
fi

# automatically initialize config/internalcmd_key if not exists
if ! [ -e config/internalcmd_key ]
then
	echo "[easymailserver.sh] Automatically generating missing config/internalcmd_key..." >&2
	node -e 'fs.writeFile("config/internalcmd_key", crypto.randomBytes(32).toString("hex"));'
fi

# automatically set default
if ! [ -e config/me ]
then
	echo "[easymailserver.sh] Automatically setting missing config/me based on current hostname: $(hostname)" >&2
	hostname >config/me

elif [ "$(cat config/me)" != "$(hostname)" ]
then
	echo "[easymailserver.sh] Warning: possible configuration mistake detected." >&2
	echo "                    Your current hostname ($(hostname)) does not match the contents of config/me ($(cat config/me))." >&2
	echo "                    To fix, execute:" >&2
	echo "                    " >&2
	echo "                        hostname >config/me" >&2
	echo "                    " >&2
fi

# setup a default certificate for our current hostname
if ! [ -e config/tls_key.pem ] && ! [ config/tls_cert.pem ]
then
	echo "[easymailserver.sh] Automatically generating missing TLS-certificate..." >&2
	openssl req -x509 -nodes -days 356000 -newkey rsa:2048 -keyout config/tls_key.pem -out config/tls_cert.pem -subj "/CN=$(head -n1 config/me)"
fi

# Set SPF/DKIM/DMARC for all configured domains, this will need manual configuration as DNS records must be updated
if [ -e config/dkim ]
then
	default_host_path="vmail/<domain>"
	
	# try to find haraka-config in a local haraka-config installation
	haraka_config_require="haraka-config"
	if ! [ -e "$haraka_config_require" ]
	then
		# try to find haraka-config in a local Haraka installation
		haraka_config_require="./node_modules/haraka-config"
		if ! [ -e "$haraka_config_require" ]
		then
			# try to find haraka-config in a global Haraka installation
			haraka_config_require="$(npm root -g)/Haraka/node_modules/haraka-config"
			if ! [ -e "$haraka_config_require" ]
			then
				# try to find haraka-config in a global haraka-config installation
				haraka_config_require="$(npm root -g)/haraka-config"
				
				if ! [ -e "$haraka_config_require" ]
				then
					# install haraka-config in the local working directory
					npm install haraka-config
					
					haraka_config_require="haraka-config"
				fi
			fi
		fi
	fi
	
	first=true
	
	node -e '
(async function()
{
const haraka_config = require("'"$haraka_config_require"'");

const host_path = haraka_config.get("config/rcpt_to.host_fs.ini")?.main?.path || "'"$default_host_path"'";
const host_path_norm = host_path.replace(/<(domain|host|domainname|hostname)>([^/]*)([/].*|)$/gi, ($0, $1, $2) => "<domain>" + $2);
const host_path_dir = path.dirname(host_path_norm);
const host_path_parts = path.basename(host_path_norm).split("<domain>");

var hostnames = await fs.promises.readdir(host_path_dir);
if(host_path_parts.length === 2)
{
	var prefix = host_path_parts[0];
	var suffix = host_path_parts[1];

	if(prefix.length > 0) hostnames = hostnames.filter(file => file.startsWith(prefix));
	if(suffix.length > 0) hostnames = hostnames.filter(file => file.endsWith(suffix));
	
	if(prefix.length > 0) hostnames = hostnames.map(file => file.substring(prefix.length));
	if(suffix.length > 0) hostnames = hostnames.map(file => file.substring(0, file.length - suffix.length));
}
else if(host_path_parts.length > 2)
{
	process.stderr.write("[easymailserver.sh] Error: Syntax error in config/rcpt_to.host_fs.ini (multiple <domain> in the same directory name is not allowed), for line: " + host_path + "\n");
	process.exit(1);
}
process.stdout.write(hostnames.join("\n"));
})();
' | while IFS= read -r hostname
	do
		if $first
		then
			# move to the config/dkim directory
			first=false
			cd config/dkim
		fi
		
		if ! [ -e "$hostname" ]
		then
			echo "[easymailserver.sh] Automatically generating missing DKIM-key for domain: $hostname" >&2
			./dkim_key_gen.sh "$hostname"
			cat "$hostname"/dns
		fi
	done
	
	# restore working directory to original
	if ! $first
	then
		cd ../..
	fi
	
	echo "[easymailserver.sh] To view the DNS-configuration of SPF/DKIM/DMARC related DNS-records for a given domain, execute:" >&2
	echo "                    " >&2
	echo "                        cat config/dkim/<domain>/dns" >&2
	echo "                    " >&2
fi

echo "[easymailserver.sh] Running haraka..." >&2

# run haraka (in the context of the current directory)
if [ -e node_modules/Haraka/bin/haraka ]
then
	node_modules/Haraka/bin/haraka -c .
else
	haraka -c .
fi
