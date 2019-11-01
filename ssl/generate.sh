#!/bin/bash

# Use this as local SSL certificate for SSL support (this is unsigned)
openssl req -x509 -newkey rsa:4096 -nodes -keyout private/key.pem -out certs/cert.pem
