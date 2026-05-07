# LiEnsina Back End

API NestJS do LiEnsina com persistencia em SQLite e autenticacao JWT.

## Autenticacao

- Access token JWT com expiracao curta: `JWT_ACCESS_EXPIRES_IN=30m`.
- Refresh token opaco, salvo no banco apenas como hash SHA-256.
- Refresh token enviado em cookie `HttpOnly`, com `SameSite=Lax`.
- Rotacao de refresh token a cada renovacao de sessao.
- Logout revoga a sessao de refresh ativa.
- Senhas de usuarios sao persistidas com hash `bcrypt`.

## Ambiente

Crie um `.env` a partir de `.env.example` e troque obrigatoriamente o `JWT_SECRET` por um segredo longo e exclusivo do ambiente.

```bash
npm install
npm run start:dev
```

A API sobe em `http://localhost:3001/api`.

## Banco

Por padrao, os dados ficam em `data/liensina.sqlite`.

O backend nao carrega dados automaticos de exemplo. Se o SQLite estiver vazio, a API inicia com colecoes vazias e aguarda dados reais cadastrados ou migrados para o banco.

As colecoes usadas pela aplicacao ficam na tabela `collections`, com payloads persistidos no SQLite. Arquivos antigos em JSON nao sao mais lidos pelo runtime.
