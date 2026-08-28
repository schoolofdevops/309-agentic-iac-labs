FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY main.go backend.go api.go worker.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags='-s -w' -o /out/inference-platform .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/inference-platform /inference-platform
USER nonroot:nonroot
EXPOSE 8080 8081
ENTRYPOINT ["/inference-platform"]
