The workloads are Deployments, so the pods have generated names
(`monize-backend-<replicaset>-<random>`) rather than the ordinal
`monize-backend-0` a StatefulSet gave them. `kubectl rollout restart` names the
workload instead of a pod, which is both stable and the only form that restarts
every replica at `cluster.mode: multi`.

```
cd ~/monize && REGISTRY=registry.laskonet.com/monize
docker build -t $REGISTRY/backend:latest --target production -f backend/Dockerfile . && docker push $REGISTRY/backend:latest && kubectl rollout restart deployment/monize-backend -n monize
docker build -t $REGISTRY/frontend:latest --target production ./frontend && docker push $REGISTRY/frontend:latest && kubectl rollout restart deployment/monize-frontend -n monize
```

# Manual code scanners
```
docker run --rm -v ~/monize:/tmp/scan bearer/bearer:latest-amd64 scan /tmp/scan --skip-rule=[javascript_lang_logger_leak,javascript_express_https_protocol_missing]
```
