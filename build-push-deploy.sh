#!/bin/sh
# This script builds and deploys the Monize backend and frontend to my private Kubernetes registry
# then restarts the Monize workloads to use the new images.
# THIS IS NOT INTENDED FOR PUBLIC USE. DO NOT USE THIS AS A TEMPLATE FOR YOUR OWN PROJECTS.

set -e

REGISTRY=registry.laskonet.com/monize
NAMESPACE=monize
WORKLOADS="monize-backend monize-frontend"

# Echoes "deployment" or "statefulset" for the named workload, whichever exists.
workload_kind() {
	for kind in deployment statefulset; do
		if kubectl get -n "$NAMESPACE" "$kind" "$1" >/dev/null 2>&1; then
			echo "$kind"
			return 0
		fi
	done
	echo "No deployment or statefulset named $1 in namespace $NAMESPACE" >&2
	return 1
}

cd ~/monize
echo "Building backend..."
docker build -t $REGISTRY/backend:latest --target production -f backend/Dockerfile .
echo "Pushing backend..."
docker push $REGISTRY/backend:latest

echo "Building frontend..."
docker build -t $REGISTRY/frontend:latest --target production ./frontend
echo "Pushing frontend..."
docker push $REGISTRY/frontend:latest

for workload in $WORKLOADS; do
	kind=$(workload_kind "$workload")
	echo "Restarting $kind/$workload..."
	kubectl rollout restart -n "$NAMESPACE" "$kind/$workload"
done

for workload in $WORKLOADS; do
	kind=$(workload_kind "$workload")
	echo "Waiting for $kind/$workload to roll out..."
	kubectl rollout status -n "$NAMESPACE" "$kind/$workload" --timeout=5m
done

echo "Done."
