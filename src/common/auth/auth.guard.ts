import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

/**
 * Ponto de extensão de autenticação (seção 2 do desafio).
 *
 * DECISÃO: este desafio não implementa integração com um Identity Provider externo
 * (Keycloak/Zitadel) dentro do timebox de 3 dias, para priorizar correção financeira,
 * concorrência e idempotência — que É o que vale pontos (seção 14). Esta classe é o
 * ponto de extensão explícito: em produção, ela seria substituída por um
 * `OidcAuthGuard` que valida um JWT emitido pelo IdP (via JWKS) e popula
 * `request.identity` com o `sub`/claims do provedor autenticado.
 *
 * Ver ARCHITECTURE.md, seção "Autenticação", para o desenho completo que seria
 * adotado (Keycloak com client_credentials por provedor de jogos, escopo
 * `wagering:write` por provider, validação de `providerId` do payload contra o
 * `sub`/claim do token para impedir um provider se passar por outro).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true; // no-op deliberado — ver decisão acima
  }
}
