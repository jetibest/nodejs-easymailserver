#!/bin/bash

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

user="$(whoami)"

# check who is the user running this script
if [ "$user" != "vmail" ]
then
	echo "WARNING:" >&2
	read -p "This script will install easymailserver for user: '$(whoami)'. Are you certain this is the user that will be running the easymailserver-service? <y/[n]> " answer
	
	echo "" >&2
	
	case "$answer" in
		[Yy]*) ;;
		*)
			echo "Exiting as per user decision. You should probably try to re-run this script as the user that will be running the easymailserver-service." >&2
			echo "Try:" >&2
			echo "" >&2
			echo "  su -s /bin/sh -c ./install.sh vmail" >&2
			echo "" >&2
			exit 1
			;;
	esac
fi

# grab the current working directory
wd="$(pwd)"

owner="$(ls -ld "$wd" | awk '{print $3}')"
if [ "$owner" != "$user" ]
then
	echo "The owner of $wd is not set to $user" >&2
	echo "Set the correct permissions using:" >&2
	echo "" >&2
	echo "  chown -R $user "'"'"$wd"'"'"" >&2
	echo "" >&2
	exit 1
fi

# use -g for a global Haraka install, if left out, Haraka will be installed locally (default)
npm_install_flags=("$@")

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
		do_node_install=false
	fi
fi

if ! command -v "npm" >/dev/null 2>/dev/null
then
	echo "In order to install, we require npm (the NodeJS Package Manager) to be installed." >&2
fi

if $do_node_install
then
	echo "Haraka requires NodeJS v16 or higher as a dependency." >&2
	
	# load nvm if not yet loaded
	if ! command -v "nvm" >/dev/null 2>/dev/null
	then
		if [ -e ~/.nvm/nvm.sh ]
		then
			. ~/.nvm/nvm.sh
		else
			# install nvm if not yet installed
			if ! [ -e nvm ]
			then
				echo "Automatically installing nvm from github repo (https://github.com/nvm-sh/nvm.git) into nvm/" >&2
				
				# download .nvm source code
				git clone https://github.com/nvm-sh/nvm.git nvm
				
				# select the right version
				cd nvm
				git checkout "$(git tag -l --sort=-taggerdate | head -n1)"
				
				# go back to the original working directory
				cd "$wd"
			else
				echo "Existing installation of nvm found at ~/.nvm/" >&2
			fi
			
			# import nvm to start using it
			. nvm/nvm.sh
		fi
	fi
	
	if ! nvm use stable >/dev/null 2>/dev/null
	then
		echo "No stable installation of NodeJS found in nvm, automatically installing stable version of NodeJS..." >&2
		
		# install the stable version of node
		nvm install stable
	fi
	
	# use stable version of node
	nvm use stable
fi

# install local package.json packages
echo "Ensuring packages from package.json are installed..." >&2
npm install
echo "" >&2

# create vmail user and group, and initialize the default directory
vmail_dir="$(realpath vmail)"
if ! id vmail >/dev/null 2>/dev/null
then
	echo "Creating user and group for vmail (with home directory at $vmail_dir)..." >&2
	groupadd -g 5000 vmail
	useradd -M -d "$vmail_dir" -s /bin/false -u 5000 -g vmail vmail
fi
if ! [ -e "$vmail_dir" ]
then
	echo "Creating vmail directory ($vmail_dir)..." >&2
	mkdir "$vmail_dir"
	chown vmail:vmail "$vmail_dir"
fi

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
		echo "  systemctl enable '$(pwd)/easymailserver.service'" >&2
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
	echo "  $(pwd)" >&2
	echo "" >&2
	exit 1
fi

