import io
import os
import logging
from typing import List, Union
from PIL import Image
import torch
from transformers import AutoProcessor, AutoModel

logger = logging.getLogger("siglip-service")
logging.basicConfig(level=logging.INFO)

MODEL_NAME = os.getenv("SIGLIP_MODEL", "google/siglip-base-patch16-224")

class SigLIPService:
    def __init__(self):
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model = None
        self.processor = None
        logger.info(f"Initializing SigLIPService on device: {self.device}")

    def load_model(self):
        if self.model is None or self.processor is None:
            logger.info(f"Loading SigLIP model from {MODEL_NAME}...")
            self.processor = AutoProcessor.from_pretrained(MODEL_NAME)
            self.model = AutoModel.from_pretrained(MODEL_NAME)
            self.model.to(self.device)
            self.model.eval()
            logger.info("SigLIP model loaded and ready.")

    def _extract_tensor(self, output):
        if hasattr(output, "pooler_output") and output.pooler_output is not None:
            return output.pooler_output
        elif isinstance(output, (tuple, list)):
            return output[0]
        elif isinstance(output, torch.Tensor):
            return output
        raise ValueError("Could not extract feature tensor from model output")

    def embed_text(self, text: str) -> List[float]:
        self.load_model()
        if not text or not text.strip():
            text = " "
        inputs = self.processor(text=[text], padding="max_length", return_tensors="pt")
        inputs = {k: v.to(self.device) for k, v in inputs.items()}
        with torch.no_grad():
            output = self.model.get_text_features(**inputs)
            features = self._extract_tensor(output)
            features = features / features.norm(dim=-1, keepdim=True)
        return features[0].cpu().tolist()

    def embed_image(self, image_input: Union[bytes, str, Image.Image]) -> List[float]:
        self.load_model()
        if isinstance(image_input, bytes):
            image = Image.open(io.BytesIO(image_input)).convert("RGB")
        elif isinstance(image_input, str):
            image = Image.open(image_input).convert("RGB")
        elif isinstance(image_input, Image.Image):
            image = image_input.convert("RGB")
        else:
            raise ValueError(f"Unsupported image input type: {type(image_input)}")

        inputs = self.processor(images=image, return_tensors="pt")
        inputs = {k: v.to(self.device) for k, v in inputs.items()}
        with torch.no_grad():
            output = self.model.get_image_features(**inputs)
            features = self._extract_tensor(output)
            features = features / features.norm(dim=-1, keepdim=True)
        return features[0].cpu().tolist()

    def embed_images_batch(self, image_inputs: List[Union[bytes, str, Image.Image]]) -> List[List[float]]:
        self.load_model()
        pil_images = []
        for inp in image_inputs:
            if isinstance(inp, bytes):
                pil_images.append(Image.open(io.BytesIO(inp)).convert("RGB"))
            elif isinstance(inp, str):
                pil_images.append(Image.open(inp).convert("RGB"))
            elif isinstance(inp, Image.Image):
                pil_images.append(inp.convert("RGB"))

        if not pil_images:
            return []

        inputs = self.processor(images=pil_images, return_tensors="pt", padding=True)
        inputs = {k: v.to(self.device) for k, v in inputs.items()}
        with torch.no_grad():
            output = self.model.get_image_features(**inputs)
            features = self._extract_tensor(output)
            features = features / features.norm(dim=-1, keepdim=True)
        return features.cpu().tolist()

    def extract_pdf_visuals(self, pdf_path: str, output_dir: str):
        """
        Extracts both embedded raster images and full-page vector diagrams (flowcharts, architecture, etc.)
        from a PDF, associating them with their true page numbers, captions, and SigLIP2 embeddings.
        """
        import uuid
        import pymupdf

        os.makedirs(output_dir, exist_ok=True)
        doc = pymupdf.open(pdf_path)
        extracted = []
        img_counter = 1

        for pno in range(len(doc)):
            page = doc[pno]
            page_num = pno + 1
            page_text = page.get_text().strip()

            # 1. Check for embedded raster images (screenshots, photos, plots)
            img_list = page.get_images(full=True)
            if img_list:
                for idx, img_info in enumerate(img_list):
                    xref = img_info[0]
                    base_image = doc.extract_image(xref)
                    ext = base_image.get("ext", "png").lower()
                    img_bytes = base_image.get("image", b"")

                    # Skip tiny decorative icons, bullets, or separators (< 1KB)
                    if len(img_bytes) < 1024:
                        continue

                    filename = f"pdf_img_{img_counter}.{ext}"
                    file_path = os.path.join(output_dir, filename)
                    with open(file_path, "wb") as f:
                        f.write(img_bytes)

                    # Extract caption from page text
                    lines = [l.strip() for l in page_text.split("\n") if l.strip() and not l.strip().isdigit()]
                    caption = lines[0] if lines else f"Figure on Page {page_num}"
                    if len(lines) > 1 and len(lines[1]) < 90:
                        caption += " - " + lines[1]

                    # Description provides visual elements grounding context
                    desc = page_text[:600].replace("\n", " ").strip()

                    try:
                        emb = self.embed_image(file_path)
                    except Exception as e:
                        logger.warning(f"Failed to embed {filename}: {e}")
                        emb = []

                    extracted.append({
                        "imageId": str(uuid.uuid4()),
                        "filename": filename,
                        "filePath": file_path,
                        "pageNumber": page_num,
                        "mimeType": f"image/{ext}" if ext != "jpg" else "image/jpeg",
                        "caption": caption,
                        "description": desc,
                        "embedding": emb
                    })
                    img_counter += 1

            # 2. Check for vector diagrams / flowcharts drawn via PDF vector graphics (e.g. System Flow, Data Flow)
            drawings = page.get_drawings()
            if drawings and len(drawings) >= 10 and not img_list:
                filename = f"pdf_diagram_p{page_num}.png"
                file_path = os.path.join(output_dir, filename)

                # Render page at 150 DPI for crisp visual presentation
                pix = page.get_pixmap(dpi=150)
                pix.save(file_path)

                lines = [l.strip() for l in page_text.split("\n") if l.strip() and not l.strip().isdigit()]
                caption = lines[0] if lines else f"Diagram on Page {page_num}"
                if len(lines) > 1 and len(lines[1]) < 90:
                    caption += " - " + lines[1]

                desc = page_text.replace("\n", " ").strip()

                try:
                    emb = self.embed_image(file_path)
                except Exception as e:
                    logger.warning(f"Failed to embed diagram {filename}: {e}")
                    emb = []

                extracted.append({
                    "imageId": str(uuid.uuid4()),
                    "filename": filename,
                    "filePath": file_path,
                    "pageNumber": page_num,
                    "mimeType": "image/png",
                    "caption": caption,
                    "description": desc,
                    "embedding": emb
                })

        logger.info(f"Extracted {len(extracted)} visuals from PDF {pdf_path}")
        return extracted

# Singleton instance
siglip_service = SigLIPService()
