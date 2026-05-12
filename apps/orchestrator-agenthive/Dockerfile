FROM golang:1.25-alpine AS builder
WORKDIR /app
COPY go.mod ./
RUN go mod download || true
COPY . .
RUN go mod tidy
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o orchestrator .

FROM gcr.io/distroless/static-debian12
COPY --from=builder /app/orchestrator /orchestrator
EXPOSE 8083
ENTRYPOINT ["/orchestrator"]
