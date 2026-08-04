#!/usr/bin/with-contenv bashio
# The base image's S6-overlay init strips the container's environment
# (SUPERVISOR_TOKEN included) from anything launched as a bare Dockerfile
# CMD — `with-contenv` is S6's own mechanism for restoring it. Without
# this, the token exists in the container but never reaches the process.
exec /usr/bin/pktnode-agent run
