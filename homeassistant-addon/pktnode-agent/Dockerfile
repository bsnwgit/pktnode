ARG BUILD_FROM
FROM $BUILD_FROM

# The exact same pktnode-agent binary every other platform build uses —
# pre-built for the target arch (see build.sh in this folder) rather than
# compiled inside this image, simpler than wiring up a Go toolchain stage
# for what's currently a single-arch (amd64) add-on.
COPY pktnode-agent /usr/bin/pktnode-agent
RUN chmod a+x /usr/bin/pktnode-agent

# run.sh (not a bare CMD pointing at the binary directly) — see its own
# comment for why: the base image's S6-overlay init strips the container
# environment, SUPERVISOR_TOKEN included, from anything launched without
# `with-contenv`.
COPY run.sh /
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
