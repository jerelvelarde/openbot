export type TypefullyCredentialAssociation = {
  serverId: string;
  userId: string;
  credentialId: string;
};

function existedBefore(
  association: TypefullyCredentialAssociation,
  before: TypefullyCredentialAssociation[],
) {
  return before.some(
    (candidate) =>
      candidate.serverId === association.serverId &&
      candidate.userId === association.userId &&
      candidate.credentialId === association.credentialId,
  );
}

/** Resolve only the one personal association an attempted smoke connection can prove it created. */
export function ownedSmokeTypefullyAssociation(input: {
  before: TypefullyCredentialAssociation[];
  current: TypefullyCredentialAssociation[];
  connectionAttempted: boolean;
  credentialId?: string;
}): TypefullyCredentialAssociation | undefined {
  if (!input.connectionAttempted) return undefined;
  const created = input.current.filter(
    (association) => !existedBefore(association, input.before),
  );
  if (input.credentialId) {
    return created.find(
      (association) => association.credentialId === input.credentialId,
    );
  }
  return created.length === 1 ? created[0] : undefined;
}
