type DateInfo = {
  year: number;
  month: number;
  day: number;
};

type Education = {
  start: DateInfo;
  end: DateInfo;
  fieldOfStudy: string;
  degree: string;
  grade: string;
  schoolName: string;
  description: string;
  activities: string;
  url: string;
  schoolId: string;
};

type Position = {
  companyId: number;
  companyName: string;
  companyUsername: string;
  companyURL: string;
  companyLogo: string;
  companyIndustry: string;
  companyStaffCountRange: string;
  title: string;
  multiLocaleTitle: { [key: string]: string };
  multiLocaleCompanyName: { [key: string]: string };
  location: string;
  description: string;
  employmentType: string;
  start: DateInfo;
  end: DateInfo;
};

type Skill = {
  name: string;
  passedSkillAssessment: boolean;
  endorsementsCount?: number;
};

type Certification = {
  name: string;
  start: DateInfo;
  end: DateInfo;
  authority: string;
  company: {
    name: string;
    universalName: string;
    logo: string;
    staffCountRange: Record<string, unknown>;
    headquarter: Record<string, unknown>;
  };
  timePeriod: {
    start: DateInfo;
    end: DateInfo;
  };
};

type LinkedInProfile = {
  urn: string;
  username: string;
  firstName: string;
  lastName: string;
  isCreator: boolean;
  isOpenToWork: boolean;
  isHiring: boolean;
  profilePicture: string;
  backgroundImage: Array<{ width: number; height: number; url: string }>;
  summary: string;
  headline: string;
  geo: { country: string; city: string; full: string };
  languages: null | Array<string>;
  educations?: Education[];
  position?: Position[];
  fullPositions: Position[];
  skills: Skill[];
  givenRecommendation: null | unknown;
  givenRecommendationCount: number;
  receivedRecommendation: null | unknown;
  receivedRecommendationCount: number;
  courses: null | unknown[];
  certifications: Certification[];
  honors: null | unknown[];
  projects: { total: number; items: null | unknown[] };
  volunteering: null | unknown;
  supportedLocales: Array<{ country: string; language: string }>;
  multiLocaleFirstName: { [key: string]: string };
  multiLocaleLastName: { [key: string]: string };
  multiLocaleHeadline: { [key: string]: string };
};

export { LinkedInProfile };
