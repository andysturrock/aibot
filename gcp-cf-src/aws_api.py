"""
    Wrappers around AWS API functions.
"""
import json
import boto3
from botocore.exceptions import ClientError


def get_secret_value(secret_name, secret_key):
    """Get a secret from AWS Secrets Manager.
    :param str secret_name: Name of the secret
    :param str secret_key: The key of the secret
    :return: The secret value
    :rtype: str
    :raises ClientError: if the caller doesn't have access to that secret
    :raises botocore.errorfactory.ResourceNotFoundException: if the secret doesn't exist
    :raises KeyError: if key doesn't exist
    """
    region_name = "eu-west-2"
    session = boto3.session.Session()
    client = session.client(
        service_name='secretsmanager',
        region_name=region_name
    )

    try:
        get_secret_value_response = client.get_secret_value(
            SecretId=secret_name
        )
    except ClientError as e:
        # For a list of exceptions thrown, see
        # https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html
        raise e

    secret = json.loads(get_secret_value_response["SecretString"])[secret_key]
    return secret
