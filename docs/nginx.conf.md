# Nginx Config

Use Nginx in front of eKeeper when you want TLS termination, a stable public hostname, and larger upload limits for source map artifacts.

Example server block:

```nginx
server {
    listen 80;
    server_name ekeeper.example.com;

    client_max_body_size 100m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;

        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

Notes:
- point `proxy_pass` at the eKeeper backend container or host
- increase `client_max_body_size` if your source maps are larger than `100m`
- set `APP_URL` to the final public URL, for example `https://ekeeper.example.com`
- if you terminate TLS in Nginx, also make sure Google OAuth callback URLs use the same HTTPS hostname
