import { Field, ID, InputType, ObjectType } from '@nestjs/graphql';

// GraphQL contract types. Deliberately separate from Prisma models: fields
// are opt-in, so a new DB column (or password_hash) can never leak by accident.

@ObjectType('User')
export class UserModel {
  @Field(() => ID)
  id: string;

  @Field()
  email: string;

  @Field()
  createdAt: Date;
}

@ObjectType('Session', { description: 'A signed-in device.' })
export class SessionModel {
  @Field(() => ID)
  id: string;

  @Field(() => String, { nullable: true })
  deviceName: string | null;

  @Field()
  createdAt: Date;

  @Field(() => Date, { nullable: true })
  lastRefreshedAt: Date | null;

  @Field()
  expiresAt: Date;

  @Field({ description: 'True for the session making this request.' })
  current: boolean;
}

@ObjectType('AuthPayload')
export class AuthPayload {
  @Field({ description: 'Short-lived JWT for the Authorization header.' })
  accessToken: string;

  @Field()
  accessTokenExpiresAt: Date;

  @Field({
    description:
      'Single-use. Store in secure storage; every refresh returns a new one.',
  })
  refreshToken: string;

  @Field()
  refreshTokenExpiresAt: Date;

  @Field(() => UserModel)
  user: UserModel;
}

@InputType()
export class RegisterInput {
  @Field()
  email: string;

  @Field({ description: '15 to 128 characters.' })
  password: string;

  @Field({ nullable: true, description: 'Shown in the session list.' })
  deviceName?: string;
}

@InputType()
export class LoginInput {
  @Field()
  email: string;

  @Field()
  password: string;

  @Field({ nullable: true })
  deviceName?: string;
}
