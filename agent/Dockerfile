FROM golang:1.22-alpine AS builder
WORKDIR /src
COPY go.mod *.go ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /dockposer-agent .

FROM docker:cli
RUN apk add --no-cache git   # für das optionale Git-Backend
COPY --from=builder /dockposer-agent /usr/local/bin/dockposer-agent
ENV DOCKPOSER_LISTEN=0.0.0.0:8720
EXPOSE 8720
ENTRYPOINT ["dockposer-agent"]
