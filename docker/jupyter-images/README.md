# Jupyter base images

By default Orqestra uses upstream `jupyter/*-notebook:latest` images. To bake in
custom dependencies (e.g. internal Python packages, pinned CUDA versions),
add a `Dockerfile.<jobType>` here and update `imageFor()` in
`apps/orchestrator-jupyter/main.go` to reference your tag.

Example:

```Dockerfile
# Dockerfile.tensorflow
FROM jupyter/tensorflow-notebook:latest

USER root
RUN pip install --no-cache-dir orqestra-internal-utils==1.2.3
USER jovyan
```

Build & push:

```bash
docker build -t orqestra/jupyter-tensorflow:latest \
  -f docker/jupyter-images/Dockerfile.tensorflow docker/jupyter-images
docker push orqestra/jupyter-tensorflow:latest
```
