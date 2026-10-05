FROM golang:1.27.1-alpine3.23 AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/notion-sync .

FROM alpine:3.23
RUN apk add --no-cache ca-certificates git
COPY --from=build /out/notion-sync /usr/local/bin/notion-sync
ENTRYPOINT ["notion-sync"]
