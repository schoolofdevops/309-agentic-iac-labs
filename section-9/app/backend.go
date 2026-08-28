package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
)

type JobStatus string

const (
	StatusQueued   JobStatus = "queued"
	StatusRunning  JobStatus = "running"
	StatusComplete JobStatus = "complete"
	StatusFailed   JobStatus = "failed"
)

type Job struct {
	ID     string    `json:"job_id"`
	Input  string    `json:"input,omitempty"`
	Status JobStatus `json:"status"`
	Result string    `json:"result,omitempty"`
	Error  string    `json:"error,omitempty"`
}

type Store struct {
	mu     sync.Mutex
	nextID int
	jobs   []*Job
}

func NewStore() *Store {
	return &Store{}
}

func (s *Store) Submit(input string) Job {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.nextID++
	job := &Job{
		ID:     fmt.Sprintf("job-%04d", s.nextID),
		Input:  input,
		Status: StatusQueued,
	}
	s.jobs = append(s.jobs, job)
	return *job
}

func (s *Store) Claim() (Job, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, job := range s.jobs {
		if job.Status == StatusQueued {
			job.Status = StatusRunning
			return *job, true
		}
	}
	return Job{}, false
}

func (s *Store) Get(id string) (Job, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, job := range s.jobs {
		if job.ID == id {
			return *job, true
		}
	}
	return Job{}, false
}

func (s *Store) Finish(id string, status JobStatus, result, jobError string) (Job, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, job := range s.jobs {
		if job.ID != id || job.Status != StatusRunning {
			continue
		}
		job.Status = status
		job.Result = result
		job.Error = jobError
		return *job, true
	}
	return Job{}, false
}

type BackendServer struct {
	store     *Store
	tokenHash [sha256.Size]byte
	mux       *http.ServeMux
}

func NewBackendServer(store *Store, token string) *BackendServer {
	server := &BackendServer{store: store, tokenHash: sha256.Sum256([]byte(token)), mux: http.NewServeMux()}
	server.mux.HandleFunc("GET /healthz", healthHandler)
	server.mux.HandleFunc("GET /readyz", healthHandler)
	server.mux.Handle("GET /internal/readyz", server.authenticate(http.HandlerFunc(healthHandler)))
	server.mux.Handle("POST /internal/jobs", server.authenticate(http.HandlerFunc(server.submit)))
	server.mux.Handle("GET /internal/jobs/{id}", server.authenticate(http.HandlerFunc(server.get)))
	server.mux.Handle("POST /internal/jobs/claim", server.authenticate(http.HandlerFunc(server.claim)))
	server.mux.Handle("PUT /internal/jobs/{id}", server.authenticate(http.HandlerFunc(server.finish)))
	return server
}

func (s *BackendServer) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	s.mux.ServeHTTP(writer, request)
}

func (s *BackendServer) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		const bearerPrefix = "Bearer "
		authorization := request.Header.Get("Authorization")
		if !strings.HasPrefix(authorization, bearerPrefix) {
			http.Error(writer, "unauthorized", http.StatusUnauthorized)
			return
		}
		provided := strings.TrimPrefix(authorization, bearerPrefix)
		providedHash := sha256.Sum256([]byte(provided))
		if subtle.ConstantTimeCompare(providedHash[:], s.tokenHash[:]) != 1 {
			http.Error(writer, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(writer, request)
	})
}

func (s *BackendServer) submit(writer http.ResponseWriter, request *http.Request) {
	var body struct {
		Input string `json:"input"`
	}
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil || body.Input == "" {
		http.Error(writer, "input is required", http.StatusBadRequest)
		return
	}
	writeJSON(writer, http.StatusAccepted, s.store.Submit(body.Input))
}

func (s *BackendServer) get(writer http.ResponseWriter, request *http.Request) {
	job, ok := s.store.Get(request.PathValue("id"))
	if !ok {
		http.Error(writer, "job not found", http.StatusNotFound)
		return
	}
	writeJSON(writer, http.StatusOK, job)
}

func (s *BackendServer) claim(writer http.ResponseWriter, _ *http.Request) {
	job, ok := s.store.Claim()
	if !ok {
		writer.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(writer, http.StatusOK, job)
}

func (s *BackendServer) finish(writer http.ResponseWriter, request *http.Request) {
	var body struct {
		Status JobStatus `json:"status"`
		Result string    `json:"result"`
		Error  string    `json:"error"`
	}
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil || (body.Status != StatusComplete && body.Status != StatusFailed) {
		http.Error(writer, "complete or failed status is required", http.StatusBadRequest)
		return
	}
	job, ok := s.store.Finish(request.PathValue("id"), body.Status, body.Result, body.Error)
	if !ok {
		http.Error(writer, "running job not found", http.StatusNotFound)
		return
	}
	writeJSON(writer, http.StatusOK, job)
}

func healthHandler(writer http.ResponseWriter, _ *http.Request) {
	writer.WriteHeader(http.StatusOK)
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}
