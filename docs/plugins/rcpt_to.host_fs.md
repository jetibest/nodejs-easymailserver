rcpt\_to.host\_fs
========

The `rcpt_to.host_fs` plugin allows you to implicitly define the domain names
this mail server accepts e-mail for, without a configuration file. The domain
names depend on the existence of a directory (e.g. `/var/mail/<domain>`).

Make sure to set the right permissions. You probably want to set ownership of
the configured path to the same user that runs easymailserver.

Configuration
-------------

Configuration is stored in `config/rcpt_to.host_fs.ini` and uses the INI style
formatting.

Example:

    path = /var/mail/<domain>

There is no further configuration possible. Furthermore, no custom sections
should be defined.
