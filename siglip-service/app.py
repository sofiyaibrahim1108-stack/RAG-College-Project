import base64
import os
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from services.siglip_service import siglip_service

app = FastAPI(
    title="SigLIP2 Embedding Microservice",
    description="Dedicated microservice for multimodal text and image embeddings",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
def health_check():
    return {
        "status": "ok",
        "service": "SigLIP2 Multimodal Service",
        "device": siglip_service.device,
        "model_loaded": siglip_service.model is not None
    }

@app.post("/embed/text")
async def embed_text(request: Request):
    try:
        body = await request.json()
        text = body.get("text", "")
        embedding = siglip_service.embed_text(text)
        return {
            "embedding": embedding,
            "dimensions": len(embedding)
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/embed/image")
async def embed_image(request: Request):
    try:
        content_type = request.headers.get("content-type", "")
        if "application/json" in content_type:
            body = await request.json()
            image_path = body.get("image_path")
            image_base64 = body.get("image_base64")

            if image_path:
                if not os.path.exists(image_path):
                    raise HTTPException(status_code=404, detail=f"Image not found at {image_path}")
                embedding = siglip_service.embed_image(image_path)
            elif image_base64:
                contents = base64.b64decode(image_base64)
                embedding = siglip_service.embed_image(contents)
            else:
                raise HTTPException(status_code=400, detail="Must provide image_path or image_base64")
        elif "multipart/form-data" in content_type:
            form = await request.form()
            file = form.get("file")
            if not file:
                raise HTTPException(status_code=400, detail="No file uploaded in form")
            contents = await file.read()
            embedding = siglip_service.embed_image(contents)
        else:
            raise HTTPException(status_code=400, detail=f"Unsupported Content-Type: {content_type}")

        return {
            "embedding": embedding,
            "dimensions": len(embedding)
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/embed/images")
async def embed_images(request: Request):
    try:
        content_type = request.headers.get("content-type", "")
        inputs = []

        if "application/json" in content_type:
            body = await request.json()
            image_paths = body.get("image_paths", [])
            images_base64 = body.get("images_base64", [])

            if image_paths:
                for p in image_paths:
                    if not os.path.exists(p):
                        raise HTTPException(status_code=404, detail=f"Image not found: {p}")
                    inputs.append(p)
            elif images_base64:
                for b64 in images_base64:
                    inputs.append(base64.b64decode(b64))
            else:
                raise HTTPException(status_code=400, detail="Must provide image_paths or images_base64")
        elif "multipart/form-data" in content_type:
            form = await request.form()
            files = form.getlist("files")
            for f in files:
                contents = await f.read()
                inputs.append(contents)
        else:
            raise HTTPException(status_code=400, detail=f"Unsupported Content-Type: {content_type}")

        embeddings = siglip_service.embed_images_batch(inputs)
        return {
            "embeddings": embeddings,
            "count": len(embeddings),
            "dimensions": len(embeddings[0]) if embeddings else 0
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/extract/pdf-visuals")
async def extract_pdf_visuals(request: Request):
    try:
        body = await request.json()
        pdf_path = body.get("pdf_path")
        output_dir = body.get("output_dir")

        if not pdf_path or not os.path.exists(pdf_path):
            raise HTTPException(status_code=404, detail=f"PDF not found at {pdf_path}")
        if not output_dir:
            raise HTTPException(status_code=400, detail="Must provide output_dir")

        images = siglip_service.extract_pdf_visuals(pdf_path, output_dir)
        return {
            "success": True,
            "images": images,
            "count": len(images)
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    port = int(os.getenv("PORT", 8000))
    print(f"Starting SigLIP microservice on port {port}...")
    uvicorn.run("app:app", host="127.0.0.1", port=port, reload=False)

