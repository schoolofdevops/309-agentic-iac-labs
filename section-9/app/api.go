package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const backendRequestTimeout = 2 * time.Second

type BackendHTTPError struct {
	StatusCode int
}

func (e *BackendHTTPError) Error() string {
	return fmt.Sprintf("backend returned HTTP %d", e.StatusCode)
}

type BackendClient struct {
	baseURL    string
	token      string
	httpClient *http.Client
}

func NewBackendClient(baseURL, token string, httpClient *http.Client) (*BackendClient, error) {
	parsed, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("invalid backend URL")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("invalid backend URL scheme")
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: backendRequestTimeout}
	} else if httpClient.Timeout <= 0 {
		copy := *httpClient
		copy.Timeout = backendRequestTimeout
		httpClient = &copy
	}
	return &BackendClient{baseURL: parsed.String(), token: token, httpClient: httpClient}, nil
}

func (c *BackendClient) Submit(ctx context.Context, input string) (Job, error) {
	var job Job
	err := c.do(ctx, http.MethodPost, "/internal/jobs", struct {
		Input string `json:"input"`
	}{Input: input}, &job, http.StatusAccepted)
	return job, err
}

func (c *BackendClient) Get(ctx context.Context, id string) (Job, error) {
	var job Job
	err := c.do(ctx, http.MethodGet, "/internal/jobs/"+url.PathEscape(id), nil, &job, http.StatusOK)
	return job, err
}

func (c *BackendClient) Claim(ctx context.Context) (Job, bool, error) {
	var job Job
	status, err := c.request(ctx, http.MethodPost, "/internal/jobs/claim", nil, &job)
	if err != nil {
		return Job{}, false, err
	}
	if status == http.StatusNoContent {
		return Job{}, false, nil
	}
	if status != http.StatusOK {
		return Job{}, false, &BackendHTTPError{StatusCode: status}
	}
	return job, true, nil
}

func (c *BackendClient) Complete(ctx context.Context, id, result string) error {
	return c.finish(ctx, id, StatusComplete, result, "")
}

func (c *BackendClient) Fail(ctx context.Context, id, jobError string) error {
	return c.finish(ctx, id, StatusFailed, "", jobError)
}

func (c *BackendClient) finish(ctx context.Context, id string, status JobStatus, result, jobError string) error {
	var job Job
	return c.do(ctx, http.MethodPut, "/internal/jobs/"+url.PathEscape(id), struct {
		Status JobStatus `json:"status"`
		Result string    `json:"result,omitempty"`
		Error  string    `json:"error,omitempty"`
	}{Status: status, Result: result, Error: jobError}, &job, http.StatusOK)
}

func (c *BackendClient) Ready(ctx context.Context) bool {
	status, err := c.request(ctx, http.MethodGet, "/internal/readyz", nil, nil)
	return err == nil && status == http.StatusOK
}

func (c *BackendClient) do(ctx context.Context, method, path string, body, target any, expectedStatus int) error {
	status, err := c.request(ctx, method, path, body, target)
	if err != nil {
		return err
	}
	if status != expectedStatus {
		return &BackendHTTPError{StatusCode: status}
	}
	return nil
}

func (c *BackendClient) request(ctx context.Context, method, path string, body, target any) (int, error) {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return 0, fmt.Errorf("encode backend request: %w", err)
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return 0, fmt.Errorf("create backend request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return 0, fmt.Errorf("backend request failed: %w", err)
	}
	defer response.Body.Close()

	if target != nil && response.StatusCode >= 200 && response.StatusCode < 300 && response.StatusCode != http.StatusNoContent {
		if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(target); err != nil {
			return 0, fmt.Errorf("decode backend response: %w", err)
		}
	} else {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<20))
	}
	return response.StatusCode, nil
}

type APIServer struct {
	client *BackendClient
	mux    *http.ServeMux
}

func NewAPIServer(client *BackendClient) *APIServer {
	server := &APIServer{client: client, mux: http.NewServeMux()}
	server.mux.HandleFunc("GET /healthz", healthHandler)
	server.mux.HandleFunc("GET /readyz", server.ready)
	server.mux.HandleFunc("POST /jobs", server.submit)
	server.mux.HandleFunc("GET /jobs/{id}", server.get)
	return server
}

func (s *APIServer) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	s.mux.ServeHTTP(writer, request)
}

func (s *APIServer) ready(writer http.ResponseWriter, request *http.Request) {
	if !s.client.Ready(request.Context()) {
		http.Error(writer, "backend unavailable", http.StatusServiceUnavailable)
		return
	}
	writer.WriteHeader(http.StatusOK)
}

func (s *APIServer) submit(writer http.ResponseWriter, request *http.Request) {
	var body struct {
		Input string `json:"input"`
	}
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil || body.Input == "" {
		http.Error(writer, "input is required", http.StatusBadRequest)
		return
	}
	job, err := s.client.Submit(request.Context(), body.Input)
	if err != nil {
		http.Error(writer, "backend unavailable", http.StatusBadGateway)
		return
	}
	writeJSON(writer, http.StatusAccepted, publicJob(job))
}

func (s *APIServer) get(writer http.ResponseWriter, request *http.Request) {
	job, err := s.client.Get(request.Context(), request.PathValue("id"))
	if err != nil {
		var backendError *BackendHTTPError
		if errors.As(err, &backendError) && backendError.StatusCode == http.StatusNotFound {
			http.Error(writer, "job not found", http.StatusNotFound)
			return
		}
		http.Error(writer, "backend unavailable", http.StatusBadGateway)
		return
	}
	writeJSON(writer, http.StatusOK, publicJob(job))
}

func publicJob(job Job) Job {
	return Job{ID: job.ID, Status: job.Status, Result: job.Result, Error: job.Error}
}
