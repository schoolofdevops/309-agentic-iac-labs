package main

import rego.v1

network_policy_note := "Rendered policy is not proof of enforcement; use a policy-capable CNI."

default_deny_spec := {
  "podSelector": {
    "matchLabels": {"app.kubernetes.io/name": "inference-platform"},
  },
  "policyTypes": ["Ingress", "Egress"],
}

api_ingress_spec := {
  "podSelector": {
    "matchLabels": {
      "app.kubernetes.io/name": "inference-platform",
      "app.kubernetes.io/component": "api",
    },
  },
  "policyTypes": ["Ingress"],
  "ingress": [{
    "ports": [{"protocol": "TCP", "port": 8080}],
  }],
}

dependencies_ingress_spec := {
  "podSelector": {
    "matchLabels": {
      "app.kubernetes.io/name": "inference-platform",
      "app.kubernetes.io/component": "dependencies",
    },
  },
  "policyTypes": ["Ingress"],
  "ingress": [{
    "from": [{
      "podSelector": {
        "matchLabels": {"app.kubernetes.io/name": "inference-platform"},
        "matchExpressions": [{
          "key": "app.kubernetes.io/component",
          "operator": "In",
          "values": ["api", "worker"],
        }],
      },
    }],
    "ports": [{"protocol": "TCP", "port": 8081}],
  }],
}

backend_egress_spec := {
  "podSelector": {
    "matchLabels": {"app.kubernetes.io/name": "inference-platform"},
    "matchExpressions": [{
      "key": "app.kubernetes.io/component",
      "operator": "In",
      "values": ["api", "worker"],
    }],
  },
  "policyTypes": ["Egress"],
  "egress": [{
    "to": [{
      "podSelector": {
        "matchLabels": {
          "app.kubernetes.io/name": "inference-platform",
          "app.kubernetes.io/component": "dependencies",
        },
      },
    }],
    "ports": [{"protocol": "TCP", "port": 8081}],
  }],
}

dns_egress_spec := {
  "podSelector": {
    "matchLabels": {"app.kubernetes.io/name": "inference-platform"},
  },
  "policyTypes": ["Egress"],
  "egress": [{
    "to": [{
      "namespaceSelector": {
        "matchLabels": {"kubernetes.io/metadata.name": "kube-system"},
      },
      "podSelector": {
        "matchLabels": {"k8s-app": "kube-dns"},
      },
    }],
    "ports": [
      {"protocol": "UDP", "port": 53},
      {"protocol": "TCP", "port": 53},
    ],
  }],
}

deny contains msg if {
  input.kind == "Secret"
  msg := "the chart must reference an external Secret, not render one"
}

deny contains msg if {
  input.kind == "Deployment"
  input.spec.template.spec.automountServiceAccountToken != false
  msg := sprintf("%s must disable service-account token mounting", [input.metadata.name])
}

deny contains msg if {
  input.kind == "Deployment"
  input.spec.template.spec.serviceAccountName == "default"
  msg := sprintf("%s must use a role-specific service account", [input.metadata.name])
}

deny contains msg if {
  input.kind == "Deployment"
  input.spec.template.spec.securityContext.runAsNonRoot != true
  msg := sprintf("%s must run as non-root", [input.metadata.name])
}

deny contains msg if {
  input.kind == "Deployment"
  input.spec.template.spec.securityContext.runAsUser != 65532
  msg := sprintf("%s must use UID 65532", [input.metadata.name])
}

deny contains msg if {
  input.kind == "Deployment"
  input.spec.template.spec.securityContext.runAsGroup != 65532
  msg := sprintf("%s must use GID 65532", [input.metadata.name])
}

deny contains msg if {
  input.kind == "Deployment"
  input.spec.template.spec.securityContext.fsGroup != 65532
  msg := sprintf("%s must grant projected volumes to fsGroup 65532", [input.metadata.name])
}

deny contains msg if {
  input.kind == "Deployment"
  input.spec.template.spec.securityContext.fsGroupChangePolicy != "OnRootMismatch"
  msg := sprintf("%s must use OnRootMismatch fsGroup ownership changes", [input.metadata.name])
}

deny contains msg if {
  input.kind == "Deployment"
  some volume in input.spec.template.spec.volumes
  volume.name == "backend-token"
  volume.projected.defaultMode != 288
  msg := sprintf("%s backend token projection must use mode 0440", [input.metadata.name])
}

deny contains msg if {
  input.kind == "Deployment"
  input.spec.template.spec.securityContext.seccompProfile.type != "RuntimeDefault"
  msg := sprintf("%s must use RuntimeDefault seccomp", [input.metadata.name])
}

deny contains msg if {
  input.kind == "Deployment"
  some container in input.spec.template.spec.containers
  container.securityContext.allowPrivilegeEscalation != false
  msg := sprintf("%s/%s must disable privilege escalation", [input.metadata.name, container.name])
}

deny contains msg if {
  input.kind == "Deployment"
  some container in input.spec.template.spec.containers
  container.securityContext.readOnlyRootFilesystem != true
  msg := sprintf("%s/%s must use a read-only root filesystem", [input.metadata.name, container.name])
}

deny contains msg if {
  input.kind == "Deployment"
  some container in input.spec.template.spec.containers
  container.securityContext.runAsUser != 65532
  msg := sprintf("%s/%s must use UID 65532", [input.metadata.name, container.name])
}

deny contains msg if {
  input.kind == "Deployment"
  some container in input.spec.template.spec.containers
  container.securityContext.capabilities.drop != ["ALL"]
  msg := sprintf("%s/%s must drop all capabilities", [input.metadata.name, container.name])
}

deny contains msg if {
  input.kind == "Deployment"
  some container in input.spec.template.spec.containers
  not container.resources.requests.cpu
  msg := sprintf("%s/%s requires a CPU request", [input.metadata.name, container.name])
}

deny contains msg if {
  input.kind == "Deployment"
  some container in input.spec.template.spec.containers
  not container.resources.requests.memory
  msg := sprintf("%s/%s requires a memory request", [input.metadata.name, container.name])
}

deny contains msg if {
  input.kind == "Deployment"
  some container in input.spec.template.spec.containers
  not container.resources.limits.cpu
  msg := sprintf("%s/%s requires a CPU limit", [input.metadata.name, container.name])
}

deny contains msg if {
  input.kind == "Deployment"
  some container in input.spec.template.spec.containers
  not container.resources.limits.memory
  msg := sprintf("%s/%s requires a memory limit", [input.metadata.name, container.name])
}

deny contains msg if {
  input.kind == "Deployment"
  some container in input.spec.template.spec.containers
  not container.livenessProbe.httpGet
  msg := sprintf("%s/%s requires an HTTP liveness probe", [input.metadata.name, container.name])
}

deny contains msg if {
  input.kind == "Deployment"
  some container in input.spec.template.spec.containers
  not container.readinessProbe.httpGet
  msg := sprintf("%s/%s requires an HTTP readiness probe", [input.metadata.name, container.name])
}

deny contains msg if {
  input.kind == "Deployment"
  some container in input.spec.template.spec.containers
  some env in container.env
  contains(upper(env.name), "TOKEN")
  env.name != "BACKEND_TOKEN_FILE"
  msg := sprintf("%s/%s must not receive a token through an environment value", [input.metadata.name, container.name])
}

deny contains msg if {
  input.kind == "Service"
  input.spec.type == "NodePort"
  input.metadata.labels["app.kubernetes.io/component"] != "api"
  msg := sprintf("%s exposes a non-API role through NodePort", [input.metadata.name])
}

deny contains msg if {
  input.kind == "NetworkPolicy"
  object.get(input.metadata.labels, "app.kubernetes.io/name", "") != "inference-platform"
  msg := sprintf("%s must use the stable inference-platform app label", [input.metadata.name])
}

deny contains msg if {
  input.kind == "NetworkPolicy"
  object.get(input.metadata.labels, "app.kubernetes.io/component", "") != "network-policy"
  msg := sprintf("%s must use the stable network-policy component label", [input.metadata.name])
}

deny contains msg if {
  input.kind == "NetworkPolicy"
  object.get(input.metadata.annotations, "inference-platform.schoolofdevops.io/enforcement-note", "") != network_policy_note
  msg := sprintf("%s must preserve the NetworkPolicy non-enforcement note", [input.metadata.name])
}

deny contains msg if {
  input.kind == "NetworkPolicy"
  endswith(input.metadata.name, "-default-deny")
  input.spec != default_deny_spec
  msg := sprintf("%s must exactly default-deny ingress and egress for inference-platform Pods", [input.metadata.name])
}

deny contains msg if {
  input.kind == "NetworkPolicy"
  endswith(input.metadata.name, "-api-ingress")
  input.spec != api_ingress_spec
  msg := sprintf("%s must expose only API TCP port 8080", [input.metadata.name])
}

deny contains msg if {
  input.kind == "NetworkPolicy"
  endswith(input.metadata.name, "-dependencies-ingress")
  input.spec != dependencies_ingress_spec
  msg := sprintf("%s must allow only API and worker ingress to dependencies TCP 8081", [input.metadata.name])
}

deny contains msg if {
  input.kind == "NetworkPolicy"
  endswith(input.metadata.name, "-backend-egress")
  input.spec != backend_egress_spec
  msg := sprintf("%s must allow only API and worker egress to dependencies TCP 8081", [input.metadata.name])
}

deny contains msg if {
  input.kind == "NetworkPolicy"
  endswith(input.metadata.name, "-dns-egress")
  input.spec != dns_egress_spec
  msg := sprintf("%s must allow only kube-dns TCP and UDP port 53", [input.metadata.name])
}
