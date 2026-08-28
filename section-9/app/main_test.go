package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const testToken = "test-backend-token"

func startTestBackend(t *testing.T) (*httptest.Server, *Store) {
	t.Helper()

	store := NewStore()
	server := httptest.NewServer(NewBackendServer(store, testToken))
	t.Cleanup(server.Close)
	return server, store
}

func newTestClient(t *testing.T, baseURL, token string) *BackendClient {
	t.Helper()

	client, err := NewBackendClient(baseURL, token, &http.Client{Timeout: time.Second})
	if err != nil {
		t.Fatalf("NewBackendClient() error = %v", err)
	}
	return client
}

func submitViaAPI(t *testing.T, server http.Handler, input string) Job {
	t.Helper()

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/jobs", bytes.NewBufferString(`{"input":`+mustJSON(t, input)+`}`))
	server.ServeHTTP(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("POST /jobs status = %d, want 202; body = %s", response.Code, response.Body.String())
	}

	var job Job
	if err := json.NewDecoder(response.Body).Decode(&job); err != nil {
		t.Fatalf("decode submitted job: %v", err)
	}
	return job
}

func mustJSON(t *testing.T, value string) string {
	t.Helper()

	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func TestAPISubmissionReturnsQueuedJob(t *testing.T) {
	backend, _ := startTestBackend(t)
	api := NewAPIServer(newTestClient(t, backend.URL, testToken))

	job := submitViaAPI(t, api, "hello api")
	if job.ID != "job-0001" || job.Status != StatusQueued {
		t.Fatalf("submitted job = %#v, want job-0001 queued", job)
	}

	response := httptest.NewRecorder()
	api.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/jobs/job-0001", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("GET /jobs/job-0001 status = %d, want 200; body = %s", response.Code, response.Body.String())
	}
	if got := response.Body.String(); got != `{"job_id":"job-0001","status":"queued"}`+"\n" {
		t.Fatalf("GET /jobs/job-0001 body = %s", got)
	}
}

func TestWorkerClaimsAndCompletesDeterministicJob(t *testing.T) {
	backend, _ := startTestBackend(t)
	client := newTestClient(t, backend.URL, testToken)
	job, err := client.Submit(t.Context(), "hello platform")
	if err != nil {
		t.Fatalf("Submit() error = %v", err)
	}

	processed, err := NewWorker(client, time.Millisecond).ProcessOne(t.Context())
	if err != nil {
		t.Fatalf("ProcessOne() error = %v", err)
	}
	if !processed {
		t.Fatal("ProcessOne() processed = false, want true")
	}

	completed, err := client.Get(t.Context(), job.ID)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if completed.Status != StatusComplete {
		t.Fatalf("status = %q, want complete", completed.Status)
	}
	if completed.Result != "MOCK INFERENCE: HELLO PLATFORM" {
		t.Fatalf("result = %q", completed.Result)
	}
}

func TestSeededFailureIsTerminalAndNotRetried(t *testing.T) {
	backend, _ := startTestBackend(t)
	client := newTestClient(t, backend.URL, testToken)
	job, err := client.Submit(t.Context(), "__fail__")
	if err != nil {
		t.Fatalf("Submit() error = %v", err)
	}
	worker := NewWorker(client, time.Millisecond)

	processed, err := worker.ProcessOne(t.Context())
	if err != nil || !processed {
		t.Fatalf("first ProcessOne() = (%v, %v), want (true, nil)", processed, err)
	}
	processed, err = worker.ProcessOne(t.Context())
	if err != nil || processed {
		t.Fatalf("second ProcessOne() = (%v, %v), want (false, nil)", processed, err)
	}

	failed, err := client.Get(t.Context(), job.ID)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if failed.Status != StatusFailed || failed.Error != "seeded inference failure" {
		t.Fatalf("failed job = %#v", failed)
	}
}

func TestBackendRejectsIncorrectTokenWithoutEchoingIt(t *testing.T) {
	backend, _ := startTestBackend(t)
	badToken := "definitely-wrong-token"
	client := newTestClient(t, backend.URL, badToken)

	_, err := client.Submit(t.Context(), "must not enter queue")
	if err == nil {
		t.Fatal("Submit() error = nil, want authentication error")
	}
	if strings.Contains(err.Error(), badToken) || strings.Contains(err.Error(), testToken) {
		t.Fatalf("authentication error leaked a token: %v", err)
	}
}

func TestBackendRequiresBearerScheme(t *testing.T) {
	backend, _ := startTestBackend(t)

	for _, test := range []struct {
		name          string
		authorization string
		wantStatus    int
	}{
		{name: "raw token", authorization: testToken, wantStatus: http.StatusUnauthorized},
		{name: "bearer token", authorization: "Bearer " + testToken, wantStatus: http.StatusAccepted},
	} {
		t.Run(test.name, func(t *testing.T) {
			request, err := http.NewRequest(http.MethodPost, backend.URL+"/internal/jobs", bytes.NewBufferString(`{"input":"auth check"}`))
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Authorization", test.authorization)
			request.Header.Set("Content-Type", "application/json")
			response, err := http.DefaultClient.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != test.wantStatus {
				t.Fatalf("status = %d, want %d", response.StatusCode, test.wantStatus)
			}
		})
	}
}

func TestMissingTokenFileFailsStartup(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing-token")
	_, err := loadToken(path)
	if err == nil {
		t.Fatal("loadToken() error = nil, want missing-file error")
	}
}

func TestAPIReadinessFailsWhenBackendIsUnavailable(t *testing.T) {
	client := newTestClient(t, "http://127.0.0.1:1", testToken)
	api := NewAPIServer(client)

	health := httptest.NewRecorder()
	api.ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if health.Code != http.StatusOK {
		t.Fatalf("GET /healthz status = %d, want 200", health.Code)
	}

	ready := httptest.NewRecorder()
	api.ServeHTTP(ready, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if ready.Code != http.StatusServiceUnavailable {
		t.Fatalf("GET /readyz status = %d, want 503", ready.Code)
	}
}

func TestAPIAndWorkerReadinessRequiresValidBackendToken(t *testing.T) {
	backend, store := startTestBackend(t)

	for _, test := range []struct {
		name       string
		handler    func(*BackendClient) http.Handler
		token      string
		wantStatus int
	}{
		{
			name:       "API correct token",
			handler:    func(client *BackendClient) http.Handler { return NewAPIServer(client) },
			token:      testToken,
			wantStatus: http.StatusOK,
		},
		{
			name:       "API wrong token",
			handler:    func(client *BackendClient) http.Handler { return NewAPIServer(client) },
			token:      "wrong-token",
			wantStatus: http.StatusServiceUnavailable,
		},
		{
			name: "worker correct token",
			handler: func(client *BackendClient) http.Handler {
				return NewWorkerServer(NewWorker(client, time.Millisecond))
			},
			token:      testToken,
			wantStatus: http.StatusOK,
		},
		{
			name: "worker wrong token",
			handler: func(client *BackendClient) http.Handler {
				return NewWorkerServer(NewWorker(client, time.Millisecond))
			},
			token:      "wrong-token",
			wantStatus: http.StatusServiceUnavailable,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			handler := test.handler(newTestClient(t, backend.URL, test.token))
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/readyz", nil))
			if response.Code != test.wantStatus {
				t.Fatalf("GET /readyz status = %d, want %d", response.Code, test.wantStatus)
			}
		})
	}
	if _, ok := store.Claim(); ok {
		t.Fatal("readiness probe mutated an empty queue")
	}
}

func TestWorkerRunStopsAfterCancellation(t *testing.T) {
	backend, _ := startTestBackend(t)
	worker := NewWorker(newTestClient(t, backend.URL, testToken), time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- worker.Run(ctx) }()

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run() error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Run() did not stop after cancellation")
	}
}

func TestHTTPServerShutsDownCleanly(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- serveHTTP(ctx, listener, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	}()

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serveHTTP() error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("serveHTTP() did not stop after cancellation")
	}
}

func TestValidateConfigRejectsMissingAndUnknownRole(t *testing.T) {
	for _, role := range []string{"", "surprise"} {
		err := validateConfig(Config{Role: role, ListenAddress: ":0", Token: testToken})
		if err == nil {
			t.Fatalf("validateConfig(Role=%q) error = nil, want role error", role)
		}
	}
}

func TestStartupRejectsInvalidConfigurationBeforeListening(t *testing.T) {
	for _, test := range []struct {
		name      string
		role      string
		tokenFile string
		wantError string
	}{
		{
			name:      "missing token file",
			role:      "dependencies",
			tokenFile: filepath.Join(t.TempDir(), "missing-token"),
			wantError: "read backend token file",
		},
		{
			name:      "missing role",
			role:      "",
			tokenFile: filepath.Join(t.TempDir(), "also-missing"),
			wantError: "ROLE must be one of",
		},
		{
			name:      "unknown role",
			role:      "surprise",
			tokenFile: filepath.Join(t.TempDir(), "also-missing"),
			wantError: "ROLE must be one of",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("ROLE", test.role)
			t.Setenv("LISTEN_ADDRESS", "127.0.0.1:0")
			t.Setenv("BACKEND_URL", "")
			t.Setenv("BACKEND_TOKEN_FILE", test.tokenFile)

			listenCalled := false
			err := runWithListener(t.Context(), func(_, _ string) (net.Listener, error) {
				listenCalled = true
				return nil, errors.New("listener should not be called")
			})
			if err == nil || !strings.Contains(err.Error(), test.wantError) {
				t.Fatalf("startup error = %v, want containing %q", err, test.wantError)
			}
			if listenCalled {
				t.Fatal("startup attempted to open a listener after invalid configuration")
			}
		})
	}
}
