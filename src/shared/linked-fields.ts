// Linked custom fields: a field whose value is another field of the same item. Ids as in the official clients.

/** The item property each linked id reads, per cipher type: login, card, identity. */
export const LINKED: Record<number, { id: number; key: string }[]> = {
  1: [
    { id: 100, key: "username" },
    { id: 101, key: "password" },
  ],
  3: [
    { id: 300, key: "cardholderName" },
    { id: 301, key: "expMonth" },
    { id: 302, key: "expYear" },
    { id: 303, key: "code" },
    { id: 304, key: "brand" },
    { id: 305, key: "number" },
  ],
  4: [
    { id: 400, key: "title" },
    { id: 401, key: "middleName" },
    { id: 402, key: "address1" },
    { id: 403, key: "address2" },
    { id: 404, key: "address3" },
    { id: 405, key: "city" },
    { id: 406, key: "state" },
    { id: 407, key: "postalCode" },
    { id: 408, key: "country" },
    { id: 409, key: "company" },
    { id: 410, key: "email" },
    { id: 411, key: "phone" },
    { id: 412, key: "ssn" },
    { id: 413, key: "username" },
    { id: 414, key: "passportNumber" },
    { id: 415, key: "licenseNumber" },
    { id: 416, key: "firstName" },
    { id: 417, key: "lastName" },
    { id: 418, key: "fullName" },
  ],
};

export const linkedKey = (type: number, id: unknown): string | undefined => LINKED[type]?.find((l) => l.id === id)?.key;

/** The value a linked field stands for. `data` is the item's login, card or identity. */
export function linkedValue(type: number, id: unknown, data: Record<string, unknown> | undefined): string {
  const key = linkedKey(type, id);
  const read = (k: string) => (typeof data?.[k] === "string" ? (data[k] as string) : "");
  if (key === "fullName") return ["title", "firstName", "middleName", "lastName"].map(read).filter(Boolean).join(" ");
  return key ? read(key) : "";
}

/** The property a page field of this type holds, per cipher type. The types are the autofill engine's. */
const BY_AUTOFILL_TYPE: Record<number, Record<string, string>> = {
  1: { Username: "username", Email: "username", CurrentPassword: "password", NewPassword: "password" },
  3: { CcName: "cardholderName", CcNumber: "number", CcExpMonth: "expMonth", CcExpYear: "expYear", CcCsc: "code", CcType: "brand" },
  4: {
    Name: "fullName",
    HonorificPrefix: "title",
    GivenName: "firstName",
    AdditionalName: "middleName",
    FamilyName: "lastName",
    Organization: "company",
    Username: "username",
    Email: "email",
    Tel: "phone",
    StreetAddress: "address1",
    AddressLine1: "address1",
    AddressLine2: "address2",
    AddressLine3: "address3",
    AddressLevel2: "city",
    AddressLevel1: "state",
    PostalCode: "postalCode",
    Country: "country",
    CountryName: "country",
  },
};

/** The linked id a page field of `autofillType` should use in this item, if it holds something the item has. */
export function linkedIdFor(type: number, autofillType: string | undefined): number | undefined {
  const key = autofillType ? BY_AUTOFILL_TYPE[type]?.[autofillType] : undefined;
  return LINKED[type]?.find((l) => l.key === key)?.id;
}
