"""
    Wrappers around GCP API functions.
"""
import os
from google.cloud import secretmanager


def get_secret_value(secret_name, secret_key):
    """Get a secret from GCP Secret Manager.
    :param str secret_name: Namespace of the secret.  This is prepended to the secret key.
    :param str secret_key: The key of the secret
    :return: The secret value
    :rtype: str
    :raises ClientError: if the caller doesn't have access to that secret
    :raises botocore.errorfactory.ResourceNotFoundException: if the secret doesn't exist
    :raises KeyError: if key doesn't exist
    """

    project_id = os.environ["GCP_PROJECT"]
    secret_name = secret_name + "_" + secret_key

    client = secretmanager.SecretManagerServiceClient()
    secret_path = client.secret_path(project_id, secret_name)
    response = client.access_secret_version(
        request={"name": f"{secret_path}/versions/latest"})

    secret_value = response.payload.data.decode("UTF-8")

    return secret_value
