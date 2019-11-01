# nodejs-easymailserver
Mailserver on NodeJS with a custom e-mail storage format using JSON

# Installation
```bash
cd /srv && git clone https://github.com/jetibest/nodejs-easymailserver
```

## Integration with systemd
**/root/nodejs-easymailserver-25.service**:
```
[Unit]
Description=Easymailserver (to receive only) [unsecure]

[Service]
Type=simple
WorkingDirectory=/srv/nodejs-easymailserver
ExecStart=/bin/bash -c 'cd /srv/nodejs-easymailserver/ && node main.js 25'
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable /root/nodejs-easymailserver-25.service
systemctl start nodejs-easymailserver-25
```

Similarly you can add a service for the secure port at 465.

# config.json

```
{
  "domains": "a.example.com,b.example.com"
}
```

Without specifying domains, e-mails for any domain will be accepted.
