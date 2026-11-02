import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import type { User } from '../../generated/prisma/client';
import { CurrentViewer, Public } from './auth.guard';
import { AuthService, type AuthResult, type Viewer } from './auth.service';
import {
  AuthPayload,
  LoginInput,
  RegisterInput,
  SessionModel,
  UserModel,
} from './identity.models';

function toUser(user: User): UserModel {
  return { id: user.id, email: user.email, createdAt: user.createdAt };
}

function toPayload(result: AuthResult): AuthPayload {
  return { ...result, user: toUser(result.user) };
}

// Presentation adapter only: translate GraphQL <-> AuthService. No rules here.
@Resolver()
export class IdentityResolver {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Mutation(() => AuthPayload)
  async register(@Args('input') input: RegisterInput): Promise<AuthPayload> {
    return toPayload(await this.auth.register(input));
  }

  @Public()
  @Mutation(() => AuthPayload)
  async login(@Args('input') input: LoginInput): Promise<AuthPayload> {
    return toPayload(await this.auth.login(input));
  }

  @Public()
  @Mutation(() => AuthPayload, {
    description:
      'Exchange a refresh token for a new token pair. The old refresh token stops working.',
  })
  async refreshSession(
    @Args('refreshToken') refreshToken: string,
  ): Promise<AuthPayload> {
    return toPayload(await this.auth.refresh(refreshToken));
  }

  @Mutation(() => Boolean, { description: 'Sign out this device.' })
  async logout(@CurrentViewer() viewer: Viewer): Promise<boolean> {
    await this.auth.logout(viewer);
    return true;
  }

  @Mutation(() => Boolean, { description: 'Sign out one of your devices.' })
  async revokeSession(
    @CurrentViewer() viewer: Viewer,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<boolean> {
    await this.auth.revokeOwnSession(viewer, id);
    return true;
  }

  @Query(() => UserModel)
  async me(@CurrentViewer() viewer: Viewer): Promise<UserModel> {
    return toUser(await this.auth.findUser(viewer.userId));
  }

  @Query(() => [SessionModel], { description: 'Your active sessions.' })
  sessions(@CurrentViewer() viewer: Viewer): Promise<SessionModel[]> {
    return this.auth.listSessions(viewer);
  }
}
