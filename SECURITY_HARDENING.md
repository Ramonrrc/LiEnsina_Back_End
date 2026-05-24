# Security hardening LiEnsina

## Criticas corrigidas

- `data/backups` foi removido do historico Git com `git filter-repo`.
- Caminhos legados com `backup/sqlite/.sql` usados apenas como scripts/docs tambem foram removidos do historico para reduzir falsos positivos dos scanners.
- Secrets JWT separados para access e refresh, sem fallback default.
- Validacao centralizada de env com fail-fast em producao.
- Refresh token em cookie `HttpOnly`, com JTI, hash persistido, rotacao e revogacao real.
- Logout revoga a sessao atual; refresh reutilizado revoga sessoes do usuario.
- Access token e refresh token usam `typ` diferente e nao sao intercambiaveis.
- `/bootstrap` e `/screens/*` foram desativados para evitar overfetching.
- CORS em producao exige allowlist explicita.
- OMR nao e publicado no host pelo compose de producao e exige token interno.
- Dumps, snapshots e credenciais foram removidos do indice e bloqueados por `.gitignore`, `.dockerignore` e hook.

## Altas corrigidas

- RBAC/ABAC centralizado em `ResourceAccessService` com filtros por papel, escola, turma, disciplina, professor, aluno e responsavel.
- DTOs e `ValidationPipe` com allowlist e rejeicao de campos desconhecidos.
- Bloqueio de mass assignment em recursos sensiveis.
- Upload com magic bytes, reencode de imagem, bloqueio de SVG/GIF/extensoes perigosas e limites de tamanho/lote.
- SSRF guard para downloads remotos com allowlist, DNS/IP validation, redirects seguros, timeout e limite de bytes.
- Rate limit por IP, usuario e tenant para mutacoes sensiveis, upload, OMR e geracao. Em producao, Redis/Valkey e obrigatorio e falha em modo fail-closed.
- Swagger desabilitado por padrao em producao e protegido por Basic Auth forte quando habilitado.
- Workflow de questoes impede `APPROVED` via payload e exige endpoint de review.

## Medias corrigidas

- Paginacao com limite maximo em listagens.
- Content-Disposition e Content-Type seguros para arquivos privados.
- Headers de seguranca no Nginx do front, incluindo CSP e anti-frame.
- Idempotency key persistente para criacao de provas, revisao/confirmacao de correcoes e OMR batch.
- Tabela `idempotency_records_rel` para deduplicacao multi-instancia, com conflito 409 para mesma chave e payload diferente.
- Lock distribuido via Redis/Valkey no `RateLimitService`.
- OMR com timeout e circuit breaker no cliente do back-end.

## Papeis globais e escolares

- `SUPERADMIN`: papel global do SaaS. Pode operar endpoints globais, alterar roles/permissoes e atribuir `SUPERADMIN`.
- `ADMIN`: mantido como alias legado global durante a transicao. Deve ser migrado para `SUPERADMIN` em seed/producao.
- `ADMIN_ESCOLA`: administrador limitado a escola vinculada. Nao lista todas as escolas, nao altera usuarios de outra escola e nao cria `SUPERADMIN`.
- `DIRETOR`, `COORDENADOR`, `PROFESSOR`, `ALUNO`, `RESPONSAVEL`: escopos escolares/pedagogicos sem permissao global.
- Alteracao de role/permissao/escola revoga refresh sessions afetadas.

## Historico Git, dumps e rotacao

Comandos executados:

```bash
python -m git_filter_repo --path data/backups --invert-paths --force
python -m git_filter_repo --replace-text ..\.codex-tmp\backend-history-replacements.txt --force
python -m git_filter_repo --path MIGRATION_SQLITE_TO_POSTGRES.md --path scripts/backup-sqlite.mjs --path scripts/migrate-sqlite-to-postgres.mjs --path scripts/rollback-to-sqlite.mjs --invert-paths --force
```

Validacao esperada:

```bash
git log --all -- data/backups
git rev-list --objects --all | rg -i "data/backups|sqlite|dump|backup|\.sql$"
git ls-files | rg -i "data/backups|sqlite|dump|backup|\.sql$"
npm run security:history
npm run security:check-files
```

Se qualquer dump antigo continha dados reais, trate como vazamento potencial:

- rotacionar `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `OMR_INTERNAL_TOKEN`, senhas de admin e qualquer credencial operacional;
- revogar sessoes ativas apos rotacao;
- mover snapshots reais para storage fora do Git, com criptografia, IAM minimo, auditoria de acesso, retencao curta e descarte documentado.

## Testes automatizados

```bash
npm test
npm run test:security
npm run build
npm run typecheck
npm audit --omit=dev
npm run security:check-files
npm run security:no-dynamic-code
```

Cobertura atual:

- IDOR por escola, turma, aluno, prova e correcao.
- Professor acessando disciplina/turma nao vinculada.
- Aluno acessando outro aluno.
- Responsavel acessando aluno nao vinculado.
- Diretor/coordenador fora do escopo.
- Coordenador tentando gerar prova.
- Campos privados omitidos em DTOs de resposta.
- Refresh token rotacionado/revogado/reutilizado.
- Sessao invalidada apos alteracao de role.
- Access token usado como refresh token.
- Usuario bloqueado usando refresh token.
- Secrets ausentes, fracos, iguais e producao sem PostgreSQL explicito.

## Validacao manual recomendada

```bash
git ls-files | rg -i "data/backups|sqlite|dump|backup|\.sql$"
npm run security:check-files
curl -i -H "Origin: https://evil.example" http://localhost:3001/api/health
curl -i http://localhost:3001/api/bootstrap
curl -i http://localhost:3001/docs
```

Em producao, teste tambem:

- Chamada direta ao OMR pela porta 8000 no host deve falhar.
- `POST /auth/refresh` com body contendo token deve retornar 400 ou 401.
- Upload SVG deve retornar 415/422.
- URL remota para localhost/metadata deve ser bloqueada.
- ID de outra escola deve retornar 403 ou 404.

## Variaveis obrigatorias em producao

- `NODE_ENV=production`
- `JWT_ACCESS_SECRET`
- `JWT_REFRESH_SECRET`
- `JWT_ACCESS_EXPIRES_IN=15m`
- `AUTH_COOKIE_SECURE=true`
- `DATABASE_DRIVER=postgres`
- `DATABASE_URL`
- `POSTGRES_PASSWORD`
- `CORS_ORIGINS`
- `OMR_INTERNAL_TOKEN`
- `OMR_SERVICE_URL`
- `SSRF_ALLOWED_HOSTS`

## Pentest HTTP black-box

Ainda exige ambiente vivo com dois tenants seedados, duas instancias do backend, PostgreSQL e Redis compartilhados. Antes de producao, executar:

```bash
npm run test:e2e
npm run test:security
npm run test:concurrency
npm run test:idor
```

Cenarios minimos: IDOR multi-tenant, mass assignment, upload malicioso, OMR sem vinculo, refresh reutilizado, role alterada, 50/100 requisicoes concorrentes, exports/downloads privados e idempotency key repetida com payload diferente.

## Riscos residuais

- O banco ainda usa colecoes JSON em PostgreSQL para compatibilidade. Antes de producao critica, migrar para tabelas relacionais com FKs, constraints compostas por tenant, indices por `school_id` e Row Level Security.
- Algumas entidades relacionais criticas ainda estao em modo shadow/compatibilidade. A aplicacao endurece ABAC/DTO/idempotencia, mas o aceite final de multi-instancia plena depende da migracao relacional por dominio.
- Auditoria existe em colecao da aplicacao; para alta criticidade, enviar tambem para trilha imutavel externa/SIEM.
- MFA para administradores ainda nao foi implementado.
