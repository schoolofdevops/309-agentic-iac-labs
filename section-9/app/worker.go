package main

import (
	"context"
	"log"
	"net/http"
	"strings"
	"time"
)

type Worker struct {
	client       *BackendClient
	pollInterval time.Duration
}

func NewWorker(client *BackendClient, pollInterval time.Duration) *Worker {
	return &Worker{client: client, pollInterval: pollInterval}
}

func (w *Worker) ProcessOne(ctx context.Context) (bool, error) {
	job, ok, err := w.client.Claim(ctx)
	if err != nil || !ok {
		return false, err
	}
	if job.Input == "__fail__" {
		return true, w.client.Fail(ctx, job.ID, "seeded inference failure")
	}
	result := "MOCK INFERENCE: " + strings.ToUpper(job.Input)
	return true, w.client.Complete(ctx, job.ID, result)
}

func (w *Worker) Run(ctx context.Context) error {
	ticker := time.NewTicker(w.pollInterval)
	defer ticker.Stop()

	for {
		if _, err := w.ProcessOne(ctx); err != nil && ctx.Err() == nil {
			log.Printf("worker poll failed: %v", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

type WorkerServer struct {
	worker *Worker
	mux    *http.ServeMux
}

func NewWorkerServer(worker *Worker) *WorkerServer {
	server := &WorkerServer{worker: worker, mux: http.NewServeMux()}
	server.mux.HandleFunc("GET /healthz", healthHandler)
	server.mux.HandleFunc("GET /readyz", server.ready)
	return server
}

func (s *WorkerServer) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	s.mux.ServeHTTP(writer, request)
}

func (s *WorkerServer) ready(writer http.ResponseWriter, request *http.Request) {
	if !s.worker.client.Ready(request.Context()) {
		http.Error(writer, "backend unavailable", http.StatusServiceUnavailable)
		return
	}
	writer.WriteHeader(http.StatusOK)
}
