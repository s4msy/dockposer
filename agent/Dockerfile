FROM golang:1.22-alpine AS builder
WORKDIR /src
COPY go.mod main.go ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /dockposer-agent .

FROM docker:cli
COPY --from=builder /dockposer-agent /usr/local/bin/dockposer-agent
ENV DOCKPOSER_LISTEN=0.0.0.0:8720
EXPOSE 8720
ENTRYPOINT ["dockposer-agent"]
