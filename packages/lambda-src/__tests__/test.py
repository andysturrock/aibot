import vertexai
from vertexai.preview.generative_models import GenerativeModel

PROJECT_ID = "PROJECT_ID_PLACEHOLDER"
REGION = "us-central1"
vertexai.init(project=PROJECT_ID, location=REGION)


generative_multimodal_model = GenerativeModel("gemini-2.0-flash-exp")
response = generative_multimodal_model.generate_content(["Tell me a joke"])

print(response)
