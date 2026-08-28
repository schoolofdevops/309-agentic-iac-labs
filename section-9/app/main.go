package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

const (
	defaultListenAddress = ":8080"
	defaultTokenFile     = "/var/run/secrets/inference/token"
	defaultPollInterval  = 50 * time.Millisecond
)

type Config struct {
	Role          string
	ListenAddress string
	BackendURL    string
	Token         string
}

type listenerFactory func(network, address string) (net.Listener, error)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := run(ctx); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context) error {
	return runWithListener(ctx, net.Listen)
}

func runWithListener(ctx context.Context, listen listenerFactory) error {
	config, err := loadConfig()
	if err != nil {
		return err
	}
	return runRoleWithListener(ctx, config, listen)
}

func loadConfig() (Config, error) {
	config := Config{
		Role:          os.Getenv("ROLE"),
		ListenAddress: os.Getenv("LISTEN_ADDRESS"),
		BackendURL:    os.Getenv("BACKEND_URL"),
	}
	if config.ListenAddress == "" {
		config.ListenAddress = defaultListenAddress
	}
	if config.Role != "dependencies" && config.Role != "api" && config.Role != "worker" {
		return Config{}, fmt.Errorf("ROLE must be one of dependencies, api, or worker")
	}

	tokenFile := os.Getenv("BACKEND_TOKEN_FILE")
	if tokenFile == "" {
		tokenFile = defaultTokenFile
	}
	token, err := loadToken(tokenFile)
	if err != nil {
		return Config{}, err
	}
	config.Token = token
	if err := validateConfig(config); err != nil {
		return Config{}, err
	}
	return config, nil
}

func loadToken(path string) (string, error) {
	contents, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read backend token file: %w", err)
	}
	token := strings.TrimSpace(string(contents))
	if token == "" {
		return "", fmt.Errorf("backend token file is empty")
	}
	return token, nil
}

func validateConfig(config Config) error {
	switch config.Role {
	case "dependencies":
	case "api", "worker":
		if config.BackendURL == "" {
			return fmt.Errorf("BACKEND_URL is required for role %s", config.Role)
		}
	default:
		return fmt.Errorf("ROLE must be one of dependencies, api, or worker")
	}
	if config.ListenAddress == "" {
		return fmt.Errorf("LISTEN_ADDRESS is required")
	}
	if config.Token == "" {
		return fmt.Errorf("backend token is required")
	}
	return nil
}

func runRole(ctx context.Context, config Config) error {
	return runRoleWithListener(ctx, config, net.Listen)
}

func runRoleWithListener(ctx context.Context, config Config, listen listenerFactory) error {
	if err := validateConfig(config); err != nil {
		return err
	}
	listener, err := listen("tcp", config.ListenAddress)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", config.ListenAddress, err)
	}

	switch config.Role {
	case "dependencies":
		return serveHTTP(ctx, listener, NewBackendServer(NewStore(), config.Token))
	case "api":
		client, err := NewBackendClient(config.BackendURL, config.Token, nil)
		if err != nil {
			_ = listener.Close()
			return err
		}
		return serveHTTP(ctx, listener, NewAPIServer(client))
	case "worker":
		client, err := NewBackendClient(config.BackendURL, config.Token, nil)
		if err != nil {
			_ = listener.Close()
			return err
		}
		worker := NewWorker(client, defaultPollInterval)
		workerContext, cancelWorker := context.WithCancel(ctx)
		defer cancelWorker()
		workerDone := make(chan error, 1)
		go func() { workerDone <- worker.Run(workerContext) }()
		serverErr := serveHTTP(ctx, listener, NewWorkerServer(worker))
		cancelWorker()
		workerErr := <-workerDone
		if serverErr != nil {
			return serverErr
		}
		return workerErr
	default:
		_ = listener.Close()
		return fmt.Errorf("unsupported role")
	}
}

func serveHTTP(ctx context.Context, listener net.Listener, handler http.Handler) error {
	server := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 2 * time.Second,
		ReadTimeout:       5 * time.Second,
		WriteTimeout:      5 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()

	select {
	case err := <-done:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("shut down HTTP server: %w", err)
		}
		err := <-done
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	}
}
