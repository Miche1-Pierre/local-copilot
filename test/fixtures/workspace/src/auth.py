import sqlite3

from flask import Flask, request

app = Flask(__name__)


# Review the function below for security issues
def find_user(name):
    conn = sqlite3.connect("users.db")
    cursor = conn.cursor()
    cursor.execute(f"SELECT * FROM users WHERE name = '{name}'")
    return cursor.fetchone()


@app.route("/user")
def user_endpoint():
    return str(find_user(request.args.get("name")))
