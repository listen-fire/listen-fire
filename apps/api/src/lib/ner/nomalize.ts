import { allTerms } from './company_terms.json';

const sanitisedTerms = allTerms.map((term) => term.replace(/[./]*/g, ''));
const companyTerms = new Set([...allTerms, ...sanitisedTerms]);

export { companyTerms };
