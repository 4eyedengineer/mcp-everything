# GHCR Pull Secret

This directory contains the Kubernetes ImagePullSecret for pulling images from GitHub Container Registry (GHCR).

## When is this needed?

- **Private images**: Required for pulling private container images from GHCR
- **Public images**: NOT needed - K8s can pull public images without authentication

## Setup

### Option 1: Using kubectl (Recommended)

```bash
# Create the secret directly using kubectl
kubectl create secret docker-registry ghcr-pull-secret \
  --docker-server=ghcr.io \
  --docker-username=YOUR_GITHUB_USERNAME \
  --docker-password=YOUR_GITHUB_PAT \
  --docker-email=YOUR_EMAIL \
  -n mcp-servers
```

### Option 2: Using the YAML template

1. Copy the example file:
   ```bash
   cp ghcr-pull-secret.yaml.example ghcr-pull-secret.yaml
   ```

2. Generate the base64-encoded Docker config:
   ```bash
   # Create the auth string (username:token in base64)
   AUTH=$(echo -n "YOUR_GITHUB_USERNAME:YOUR_GITHUB_PAT" | base64)

   # Create the full config JSON and encode it
   echo -n "{\"auths\":{\"ghcr.io\":{\"username\":\"YOUR_GITHUB_USERNAME\",\"password\":\"YOUR_GITHUB_PAT\",\"auth\":\"$AUTH\"}}}" | base64
   ```

3. Replace `<BASE64_ENCODED_DOCKER_CONFIG_JSON>` in the YAML file

4. Apply the secret:
   ```bash
   kubectl apply -f ghcr-pull-secret.yaml
   ```

## GitHub PAT Requirements

Your GitHub Personal Access Token needs the following scope:
- `read:packages` - To pull container images from GHCR

For the backend service that pushes images, you also need:
- `write:packages` - To push container images to GHCR

## Using the Secret in Deployments

Add `imagePullSecrets` to your Pod spec:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: my-mcp-server
  namespace: mcp-servers
spec:
  containers:
    - name: mcp-server
      image: ghcr.io/4eyedengineer/mcp-servers/my-server:latest
  imagePullSecrets:
    - name: ghcr-pull-secret
```

## Verification

```bash
# Check if secret exists
kubectl get secret ghcr-pull-secret -n mcp-servers

# Verify secret contents (careful with sensitive data)
kubectl get secret ghcr-pull-secret -n mcp-servers -o jsonpath='{.data.\.dockerconfigjson}' | base64 -d
```

## Troubleshooting

### Image pull fails with "unauthorized"
- Verify your GitHub PAT hasn't expired
- Ensure the PAT has `read:packages` scope
- Check that the username matches the PAT owner

### Secret not found
- Ensure the secret is in the `mcp-servers` namespace
- Verify the secret name matches `ghcr-pull-secret`
