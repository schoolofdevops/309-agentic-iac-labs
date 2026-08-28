{{- define "inference-platform.name" -}}
{{- .Chart.Name -}}
{{- end -}}

{{- define "inference-platform.roleName" -}}
{{ printf "%s-%s" (include "inference-platform.name" .root) .role }}
{{- end -}}

{{- define "inference-platform.labels" -}}
app.kubernetes.io/name: {{ include "inference-platform.name" .root }}
app.kubernetes.io/component: {{ .role }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
{{- end -}}

{{- define "inference-platform.selectorLabels" -}}
app.kubernetes.io/name: {{ include "inference-platform.name" .root }}
app.kubernetes.io/component: {{ .role }}
{{- end -}}
