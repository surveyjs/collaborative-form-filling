import { NgModule } from "@angular/core";
import { BrowserModule } from "@angular/platform-browser";
import { SurveyModule } from "survey-angular-ui";

import { AppComponent } from "./app.component";
import { ParticipantsBarComponent } from "./participants-bar/participants-bar.component";

@NgModule({
  declarations: [AppComponent, ParticipantsBarComponent],
  imports: [BrowserModule, SurveyModule],
  bootstrap: [AppComponent]
})
export class AppModule { }
