export type TypefullyCredentialAssociation = {
  serverId: string;
  userId: string;
  credentialId: string;
};

export type TypefullyCredentialRecord = {
  id: string;
  provider: string;
  keyId: string;
  createdAt: Date;
};

/** Capture cleanup authority only after a successful mutation, never from a snapshot difference. */
export function confirmedSmokeTypefullyAssociation(input: {
  connectionConfirmed: boolean;
  actorId: string;
  runStartedAt: Date;
  associations: TypefullyCredentialAssociation[];
  credentials: TypefullyCredentialRecord[];
}): TypefullyCredentialAssociation | undefined {
  if (!input.connectionConfirmed) return undefined;
  const association = input.associations.find(
    (candidate) =>
      candidate.serverId === "typefully" && candidate.userId === input.actorId,
  );
  if (!association) return undefined;
  const credential = input.credentials.find(
    (candidate) =>
      candidate.id === association.credentialId &&
      candidate.provider === "typefully" &&
      candidate.keyId === input.actorId &&
      candidate.createdAt.getTime() >= input.runStartedAt.getTime(),
  );
  return credential ? association : undefined;
}
