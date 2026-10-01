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
        inputs = self.processor(text=[text], return_tensors="pt", padding=True)
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

# Singleton instance
siglip_service = SigLIPService()
