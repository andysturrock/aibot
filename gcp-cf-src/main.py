import functions_framework


@functions_framework.http
def http(request):
    """HTTP Cloud Function.
    Args:
        request (flask.Request): The request object.
        <https://flask.palletsprojects.com/en/1.1.x/api/#incoming-request-data>
    Returns:
        The response text, or any set of values that can be turned into a
        Response object using `make_response`
        <https://flask.palletsprojects.com/en/1.1.x/api/#flask.make_response>.
    """
    if request.headers.get('X-CloudScheduler') != 'true':
        print("Request not authenticated as coming from Cloud Scheduler.")
        # return "Request not authenticated as coming from Cloud Scheduler.", 403

    request_json = request.get_json(silent=True)
    request_args = request.args

    print(f"*****\nrequest: {request}\n*****\n")

    if request_json and 'name' in request_json:
        name = request_json['name']
    elif request_args and 'name' in request_args:
        name = request_args['name']
    else:
        name = 'World'
    return f"Hello {name}!"
