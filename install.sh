#!/bin/bash

STABLE_NODE_VERSION="lts/gallium"
EMAIL_USER="vmail"
EMAIL_GROUP="vmail"

# EasyMailServer install script
# 
# install.sh ensures (= it can be safely run multiple times):
# 
#  - NodeJS v16 or higher is installed (using nvm)
#  - Haraka is installed (using npm)
#  - easymailserver.service is linked and enabled (in systemd systems)
# 

set -e # automatically exit if any command fails

# ensure we are in the right local working directory (easymailserver/)
if ! [ -e easymailserver.sh ]
then
	echo "Error: install.sh must be run with its parent directory as the working directory." >&2
	exit 1
fi

wd="$(pwd)"

if [ "$1" = "node" ]
then
	# detect if we need to install a later version of NodeJS (minimally required is v16)
	do_node_install=true
	
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
			# version is at least v16, which good enough
			exit 0
		fi
	fi
	
	# currently available NodeJS version is not good enough
	exit 1

elif [ "$1" = "nvm" ]
then
	# load nvm if not yet loaded
	if ! command -v "nvm" >/dev/null 2>/dev/null || ! nvm list >/dev/null 2>/dev/null
	then
		if ! [ -e nvm/nvm.sh ]
		then
			# install nvm if not yet installed
			echo "Automatically installing nvm from github repo (https://github.com/nvm-sh/nvm.git) into nvm/" >&2
			
			# download .nvm source code
			git clone https://github.com/nvm-sh/nvm.git nvm
			
			# select the right version
			cd nvm
			#git checkout "$(git tag -l --sort=-taggerdate | head -n1)"
			git checkout `git describe --abbrev=0 --tags --match "v[0-9]*" $(git rev-list --tags --max-count=1)`
			
			# go back to the original working directory
			cd "$wd"
		fi
		
		# import nvm to start using it
		. nvm/nvm.sh
	fi
	
	if ! nvm use "$STABLE_NODE_VERSION" >/dev/null 2>/dev/null
	then
		echo "No LTS installation of NodeJS found in nvm, automatically installing LTS version of NodeJS..." >&2
		
		# install the stable version of node
		nvm install "$STABLE_NODE_VERSION"
	fi
	
	# use stable version of node
	nvm use "$STABLE_NODE_VERSION"
	
	exit 0

elif [ "$1" = "npm" ]
then
	# try to source nvm if exists
	if [ -e nvm/nvm.sh ]
	then
		. nvm/nvm.sh
		
	elif [ -e ~/.nvm/nvm.sh ]
	then
		. ~/.nvm/nvm.sh
	fi
	
	# if nvm is installed, use it to set NodeJS version to stable, or latest (this is useful for systems with an old native version of NodeJS)
	if command -v nvm >/dev/null 2>/dev/null
	then
		if ! nvm use "$STABLE_NODE_VERSION"
		then
			echo "Run ./install.sh"
			exit 1
		fi
	fi
	
	npm install
	
	exit 0
fi

# create vmail user and group, and initialize the default directory
vmail_dir="$(realpath "./vmail")"
if ! id "$EMAIL_USER" >/dev/null 2>/dev/null
then
	echo "Creating user and group for vmail (with home directory at $vmail_dir)..." >&2
	groupadd -g 5000 "$EMAIL_GROUP"
	useradd -M -d "$vmail_dir" -s /bin/false -u 5000 -g "$EMAIL_GROUP" "$EMAIL_USER"
fi
if ! [ -e "$vmail_dir" ]
then
	echo "Creating vmail directory ($vmail_dir)..." >&2
	mkdir "$vmail_dir"
fi

# fix permissions in this current working directory
chown -R "$EMAIL_USER":"$EMAIL_GROUP" .
# and in the vmail directory
chown -R "$EMAIL_USER":"$EMAIL_GROUP" "$vmail_dir"


if ! command -v "npm" >/dev/null 2>/dev/null
then
	echo "In order to continue installation, we require npm (the NodeJS Package Manager) to be installed." >&2
	exit 1
fi

if ! su - -s /bin/sh -c "cd '$wd' && ./install.sh node" "$EMAIL_USER"
then
	echo "Haraka requires NodeJS v16 or higher as a dependency." >&2
	
	su - -s /bin/sh -c "cd '$wd' && ./install.sh nvm" "$EMAIL_USER"
fi

# install local package.json packages
echo "Ensuring packages from package.json are installed..." >&2
su - -s /bin/sh -c "cd '$wd' && ./install.sh npm" "$EMAIL_USER"
echo "" >&2

# enable the easymailserver-service
if command -v systemctl >/dev/null 2>/dev/null
then
	if ! systemctl status easymailserver >/dev/null 2>/dev/null
	then
		service_path="$wd/easymailserver.service"
		if ! [ -e "$service_path" ]
		then
			echo "Error: Service file not found ($service_path). Manually enable the service file using:" >&2
			echo "" >&2
			echo "  systemctl enable /absolute/path/to/easymailserver.service" >&2
			echo "" >&2
			exit 1
		fi
		
		# fix path in the service-file, based on the current directory
		sed -i -e 's#^WorkingDirectory=.*$#WorkingDirectory='"$wd"'#g' -e 's#^ExecStart=.*$#ExecStart='"$wd"'/easymailserver.sh#g' "$service_path"
		
		echo "First enable the easymailserver service:" >&2
		echo "" >&2
		echo "  systemctl enable '$wd/easymailserver.service'" >&2
		echo "" >&2
	fi
	
	echo "You can start running easymailserver using:" >&2
	echo "" >&2
	echo "  systemctl start easymailserver" >&2
	echo "" >&2
else
	echo "WARNING:" >&2
	echo "Only systemctl is supported by this install-script. You should either:" >&2
	echo "" >&2
	echo "  -> manually create an init script for easymailserver" >&2
	echo "  -> or manually run ./easymailserver.sh" >&2
	echo "" >&2
	echo "Note that when running easymailserver, the working directory should be:" >&2
	echo "" >&2
	echo "  $wd" >&2
	echo "" >&2
	exit 1
fi

